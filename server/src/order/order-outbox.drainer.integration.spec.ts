import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORDER_OUTBOX_CLAIM_IDLE_MS, REDIS_URL } from '../config/env.ts';
import { OrderOutboxDrainer } from './order-outbox.drainer.ts';
import { ORDER_OUTBOX_GROUP } from './order-outbox.ts';
import { createTestQueue } from './order-queue.test-support.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';

describe('OrderOutboxDrainer (integration)', () => {
  const redis = new Redis(REDIS_URL);
  const queue = createTestQueue();
  const producer = new OrderQueueProducer(queue);
  let outboxKey: string;
  let drainer: OrderOutboxDrainer;

  beforeEach(() => {
    outboxKey = `order-outbox-test-${randomUUID()}`;
    drainer = new OrderOutboxDrainer(redis, outboxKey, producer);
  });

  afterEach(async () => {
    await drainer.onModuleDestroy();
    await redis.del(outboxKey);
    await queue.drain();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });

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

  async function pendingCount(): Promise<number> {
    const [count] = (await redis.xpending(outboxKey, ORDER_OUTBOX_GROUP)) as [
      number,
    ];
    return count;
  }

  it('turns outbox entries into persist-order jobs and removes them from the stream', async () => {
    const saleId = randomUUID();
    await append(saleId, 'user-1');
    await append(saleId, 'user-2');

    await expect(drainer.drainOnce()).resolves.toBe(2);

    const waiting = await queue.getWaiting();
    expect(waiting.map((job) => job.id).sort()).toEqual([
      `${saleId}|user-1`,
      `${saleId}|user-2`,
    ]);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('delivers entries that were appended before any drainer ever ran (first boot, or Redis came back empty)', async () => {
    const saleId = randomUUID();
    await append(saleId, 'user-1');
    // No group exists yet: the reserve script created the stream on its own
    await expect(
      redis.xinfo('GROUPS', outboxKey) as Promise<unknown[]>,
    ).resolves.toEqual([]);

    await expect(drainer.drainOnce()).resolves.toBe(1);

    await expect(queue.getWaitingCount()).resolves.toBe(1);
  });

  it('keeps a failed enqueue pending and retries it on the next pass', async () => {
    const saleId = randomUUID();
    await append(saleId, 'user-1');
    const realAdd = queue.add.bind(queue);
    queue.add = () => Promise.reject(new Error('simulated enqueue failure'));

    await expect(drainer.drainOnce()).resolves.toBe(1);
    await expect(queue.getWaitingCount()).resolves.toBe(0);
    await expect(redis.xlen(outboxKey)).resolves.toBe(1);
    await expect(pendingCount()).resolves.toBe(1);

    queue.add = realAdd;
    await expect(drainer.drainOnce()).resolves.toBe(1);

    await expect(queue.getWaitingCount()).resolves.toBe(1);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('picks up an entry Redis delivered to it but that it never processed (a read that timed out client-side)', async () => {
    const saleId = randomUUID();
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

    await expect(drainer.drainOnce()).resolves.toBe(1);

    await expect(queue.getWaitingCount()).resolves.toBe(1);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
  });

  it("reclaims another consumer's entry only once it has been idle for ORDER_OUTBOX_CLAIM_IDLE_MS", async () => {
    const saleId = randomUUID();
    await createGroup();
    const id = await append(saleId, 'user-1');
    // A worker that read the entry and then died before enqueueing it
    await redis.xreadgroup(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      'dead-worker',
      'STREAMS',
      outboxKey,
      '>',
    );

    // Not idle long enough: left alone
    await expect(drainer.drainOnce()).resolves.toBe(0);
    await expect(queue.getWaitingCount()).resolves.toBe(0);

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
    await expect(drainer.drainOnce()).resolves.toBe(1);

    await expect(queue.getWaitingCount()).resolves.toBe(1);
    await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    await expect(pendingCount()).resolves.toBe(0);
  });

  it('is idempotent across two drainers sharing the group: an entry is delivered to exactly one of them', async () => {
    const other = new OrderOutboxDrainer(redis, outboxKey, producer);
    try {
      const saleId = randomUUID();
      await append(saleId, 'user-1');

      const handled = await Promise.all([
        drainer.drainOnce(),
        other.drainOnce(),
      ]);

      expect(handled.reduce((a, b) => a + b, 0)).toBe(1);
      await expect(queue.getWaitingCount()).resolves.toBe(1);
      await expect(redis.xlen(outboxKey)).resolves.toBe(0);
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('survives Redis being wiped underneath it (NOGROUP) by recreating the group on the next pass', async () => {
    const saleId = randomUUID();
    await append(saleId, 'user-1');
    await drainer.drainOnce();

    // Simulate a wipe: the stream (and with it the group) is gone, then the
    // reserve script recreates the stream with a new entry
    await redis.del(outboxKey);
    await append(saleId, 'user-2');

    await expect(drainer.drainOnce()).rejects.toThrow(/NOGROUP/);
    drainer['groupReady'] = false;
    await expect(drainer.drainOnce()).resolves.toBe(1);

    await expect(queue.getWaitingCount()).resolves.toBe(2);
  });
});
