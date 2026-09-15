import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ORDER_OUTBOX_CLAIM_IDLE_MS,
  PERSIST_ORDER_ATTEMPTS,
  REDIS_URL,
} from '../config/env.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { OrderOutboxDrainer } from './order-outbox.drainer.ts';
import { OrderOutboxService } from './order-outbox.service.ts';
import {
  ORDER_OUTBOX_GROUP,
  orderOutboxDeadLetterKey,
} from './order-outbox.ts';
import { PRUNE_OUTBOX_CONSUMERS_SCRIPT } from './prune-outbox-consumers-script.ts';

// Dead-letter quickly so the test need not fail an entry 50 times
vi.hoisted(() => {
  process.env.PERSIST_ORDER_ATTEMPTS = '3';
});

describe('OrderOutboxDrainer (integration)', () => {
  const redis = new Redis(REDIS_URL);
  const prisma = new PrismaService();
  const saleIds: string[] = [];
  let outboxKey: string;
  let outbox: OrderOutboxService;
  let drainer: OrderOutboxDrainer;

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  beforeEach(() => {
    outboxKey = `order-outbox-test-${randomUUID()}`;
    outbox = new OrderOutboxService(redis, outboxKey);
    drainer = new OrderOutboxDrainer(redis, outboxKey, prisma);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drainer.onModuleDestroy();
    await redis.del(outboxKey, orderOutboxDeadLetterKey(outboxKey));
    await prisma.order.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    await redis.quit();
  });

  async function createSale(): Promise<string> {
    const sale = await prisma.sale.create({
      data: {
        productName: 'Test Product',
        totalStock: 10,
        startTime: new Date(),
        endTime: new Date(Date.now() + 60_000),
      },
    });
    saleIds.push(sale.id);
    return sale.id;
  }

  async function createGroup(): Promise<void> {
    await redis.xgroup(
      'CREATE',
      outboxKey,
      ORDER_OUTBOX_GROUP,
      '0',
      'MKSTREAM',
    );
  }

  async function append(saleId: string, userId: string): Promise<string> {
    return (await redis.xadd(
      outboxKey,
      '*',
      'saleId',
      saleId,
      'userId',
      userId,
      'timestamp',
      new Date().toISOString(),
    )) as string;
  }

  async function consumerNames(): Promise<string[]> {
    const consumers = (await redis.xinfo(
      'CONSUMERS',
      outboxKey,
      ORDER_OUTBOX_GROUP,
    )) as (string | number)[][];
    return consumers.map((fields) => String(fields[1])).sort();
  }

  async function readAs(consumer: string): Promise<void> {
    await redis.xreadgroup(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      consumer,
      'STREAMS',
      outboxKey,
      '>',
    );
  }

  async function pendingCount(): Promise<number> {
    const [count] = (await redis.xpending(outboxKey, ORDER_OUTBOX_GROUP)) as [
      number,
    ];
    return count;
  }

  function orderedUsers(saleId: string): Promise<string[]> {
    return prisma.order
      .findMany({ where: { saleId }, select: { userId: true } })
      .then((orders) => orders.map((order) => order.userId).sort());
  }

  const failWrites = () =>
    vi
      .spyOn(prisma.order, 'createMany')
      .mockRejectedValue(new Error('simulated write failure'));

  it('turns outbox entries into Order rows and removes them from the stream', async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    await append(saleId, 'user-2');

    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 2,
      backoffMs: 0,
    });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1', 'user-2']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('delivers entries that were appended before any drainer ever ran (first boot, or Redis came back empty)', async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    // No group exists yet: the reserve script created the stream on its own
    await expect(
      redis.xinfo('GROUPS', outboxKey) as Promise<unknown[]>,
    ).resolves.toEqual([]);

    await expect(drainer.drainOnce()).resolves.toMatchObject({ handled: 1 });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
  });

  it('keeps a failed write pending, backs off, and lands it on the next pass', async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    const writes = failWrites();

    const failedPass = await drainer.drainOnce();
    expect(failedPass.handled).toBe(1);
    expect(failedPass.backoffMs).toBeGreaterThan(0);
    await expect(orderedUsers(saleId)).resolves.toEqual([]);
    await expect(redis.xlen(outboxKey)).resolves.toBe(1);
    await expect(pendingCount()).resolves.toBe(1);

    writes.mockRestore();
    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 1,
      backoffMs: 0,
    });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('lands the rest of a batch when one entry can never be written (its sale is gone), and leaves only that one pending', async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    await append(randomUUID(), 'user-poison');
    await append(saleId, 'user-2');

    const result = await drainer.drainOnce();

    expect(result.handled).toBe(3);
    expect(result.backoffMs).toBeGreaterThan(0);
    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1', 'user-2']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(1);
    await expect(pendingCount()).resolves.toBe(1);
  });

  it(`dead-letters an entry after PERSIST_ORDER_ATTEMPTS failed passes, where a human can replay it once the cause is fixed`, async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    const writes = failWrites();

    for (let attempt = 1; attempt < PERSIST_ORDER_ATTEMPTS; attempt++) {
      await drainer.drainOnce();
      await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([]);
      await expect(pendingCount()).resolves.toBe(1);
    }
    await drainer.drainOnce();

    // Gone from the outbox, present in the dead-letter stream
    await expect(outbox.listDeadLettered(saleId)).resolves.toEqual(['user-1']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
    // ... and no longer retried, even with Postgres healthy again
    writes.mockRestore();
    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 0,
      backoffMs: 0,
    });
    await expect(orderedUsers(saleId)).resolves.toEqual([]);

    // A human replays it and the Order lands
    await expect(outbox.replayDeadLettered(saleId, 'user-1')).resolves.toBe(
      true,
    );
    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 1,
      backoffMs: 0,
    });
    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
    await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([]);
  });

  it('picks up an entry Redis delivered to it but that it never processed (a read that timed out client-side)', async () => {
    const saleId = await createSale();
    await createGroup();
    await append(saleId, 'user-1');
    // Deliver the entry to this drainer's consumer behind its back
    await redis.xreadgroup(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      drainer['consumerName'],
      'STREAMS',
      outboxKey,
      '>',
    );
    await expect(pendingCount()).resolves.toBe(1);

    await expect(drainer.drainOnce()).resolves.toMatchObject({ handled: 1 });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
  });

  it("reclaims another consumer's entry only once it has been idle for ORDER_OUTBOX_CLAIM_IDLE_MS", async () => {
    const saleId = await createSale();
    await createGroup();
    const id = await append(saleId, 'user-1');
    // A worker that read the entry and then died before writing it
    await readAs('dead-worker');

    // Not idle long enough: left alone
    await expect(drainer.drainOnce()).resolves.toMatchObject({ handled: 0 });
    await expect(orderedUsers(saleId)).resolves.toEqual([]);

    // Age it past the threshold
    await redis.xclaim(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      'dead-worker',
      0,
      id,
      'IDLE',
      ORDER_OUTBOX_CLAIM_IDLE_MS + 1,
    );
    await expect(drainer.drainOnce()).resolves.toMatchObject({ handled: 1 });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('is idempotent across two drainers sharing the group: an entry is delivered to exactly one of them', async () => {
    const other = new OrderOutboxDrainer(redis, outboxKey, prisma);
    try {
      const saleId = await createSale();
      await append(saleId, 'user-1');

      const handled = await Promise.all([
        drainer.drainOnce(),
        other.drainOnce(),
      ]);

      expect(handled.reduce((sum, { handled }) => sum + handled, 0)).toBe(1);
      await expect(orderedUsers(saleId)).resolves.toEqual(['user-1']);
      await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('removes its own consumer from the group on shutdown', async () => {
    const stopping = new OrderOutboxDrainer(redis, outboxKey, prisma);
    await stopping.drainOnce();
    await expect(consumerNames()).resolves.toHaveLength(1);

    await stopping.onModuleDestroy();

    await expect(consumerNames()).resolves.toHaveLength(0);
  });

  it('keeps its consumer on shutdown while an entry it read is still pending', async () => {
    const stopping = new OrderOutboxDrainer(redis, outboxKey, prisma);
    const saleId = await createSale();
    await createGroup();
    await append(saleId, 'user-1');
    // Read as the drainer's own consumer but never ack (a write that failed)
    await readAs(stopping['consumerName']);

    await stopping.onModuleDestroy();

    await expect(consumerNames()).resolves.toEqual([stopping['consumerName']]);
    await expect(pendingCount()).resolves.toBe(1);
  });

  it('prunes idle consumers that hold nothing pending, and only those', async () => {
    const saleId = await createSale();
    await createGroup();
    await append(saleId, 'user-1');
    await readAs('dead-with-pending');
    await readAs('dead-idle');
    await readAs('me');
    await expect(consumerNames()).resolves.toEqual([
      'dead-idle',
      'dead-with-pending',
      'me',
    ]);

    // Min idle 0 so the test need not wait out ORDER_OUTBOX_CLAIM_IDLE_MS
    await expect(
      redis.eval(
        PRUNE_OUTBOX_CONSUMERS_SCRIPT,
        1,
        outboxKey,
        ORDER_OUTBOX_GROUP,
        0,
        'me',
      ),
    ).resolves.toBe(1);

    await expect(consumerNames()).resolves.toEqual(['dead-with-pending', 'me']);
    await expect(pendingCount()).resolves.toBe(1);
  });

  it('survives Redis being wiped underneath it (NOGROUP) by recreating the group on the next pass', async () => {
    const saleId = await createSale();
    await append(saleId, 'user-1');
    await drainer.drainOnce();

    // Simulate a wipe: the stream (and with it the group) is gone, then the
    // reserve script recreates the stream with a new entry
    await redis.del(outboxKey);
    await append(saleId, 'user-2');

    await expect(drainer.drainOnce()).rejects.toThrow(/NOGROUP/);
    drainer['groupReady'] = false;
    await expect(drainer.drainOnce()).resolves.toMatchObject({ handled: 1 });

    await expect(orderedUsers(saleId)).resolves.toEqual(['user-1', 'user-2']);
  });
});
