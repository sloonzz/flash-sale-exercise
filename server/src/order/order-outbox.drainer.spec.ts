import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_OUTBOX_CLAIM_IDLE_MS,
  PERSIST_ORDER_ATTEMPTS,
} from '../config/env.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import {
  ORDER_OUTBOX_BATCH_SIZE,
  ORDER_OUTBOX_BLOCK_MS,
  OrderOutboxDrainer,
} from './order-outbox.drainer.ts';
import {
  ORDER_OUTBOX_GROUP,
  orderOutboxDeadLetterKey,
} from './order-outbox.ts';
import {
  PERSIST_ORDER_BACKOFF_BASE_MS,
  PERSIST_ORDER_BACKOFF_JITTER,
} from './persist-order-retry.ts';
import { PRUNE_OUTBOX_CONSUMERS_SCRIPT } from './prune-outbox-consumers-script.ts';

const within = (value: number, target: number) => {
  const tolerance = target * PERSIST_ORDER_BACKOFF_JITTER;
  expect(value).toBeGreaterThanOrEqual(target - tolerance);
  expect(value).toBeLessThanOrEqual(target + tolerance);
};

describe('OrderOutboxDrainer', () => {
  const outboxKey = 'order-outbox-test';
  const multi = {
    xack: vi.fn().mockReturnThis(),
    xdel: vi.fn().mockReturnThis(),
    xadd: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  // Per-entry XPENDING lookups are pipelined; each reply is [err, rows]
  const pipeline = {
    xpending: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const client = {
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
    xgroup: vi.fn().mockResolvedValue('OK'),
    xautoclaim: vi.fn().mockResolvedValue(['0-0', [], []]),
    xreadgroup: vi.fn().mockResolvedValue(null),
    xpending: vi.fn().mockResolvedValue([]),
    eval: vi.fn().mockResolvedValue(0),
    multi: vi.fn(() => multi),
    pipeline: vi.fn(() => pipeline),
  };
  const sharedRedis = { duplicate: vi.fn(() => client) } as unknown as Redis;
  const prisma = {
    order: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaService;
  const createMany = vi.mocked(prisma.order.createMany);

  // What the pipelined XPENDING replies say each entry's delivery count is
  function deliveries(counts: Record<string, number>): void {
    pipeline.xpending.mockImplementation(function (this: typeof pipeline) {
      return this;
    });
    pipeline.exec.mockImplementation(() => {
      const ids = pipeline.xpending.mock.calls.map((call) => call[2] as string);
      return Promise.resolve(
        ids.map((id) => [null, [[id, 'me', 0, counts[id] ?? 1]]]),
      );
    });
  }

  // Row shape persistOrders writes for an entry
  const row = ([, fields]: StreamEntry) => ({
    saleId: fields[1],
    userId: fields[3],
    createdAt: new Date(fields[5]),
  });

  // A pass reads the consumer's own pending entries (id '0') and then blocks
  // for new ones (id '>'); mock each read separately.
  function stream(ownPending: StreamEntry[], fresh: StreamEntry[]): void {
    client.xreadgroup.mockImplementation((...args: unknown[]) =>
      Promise.resolve([[outboxKey, args.at(-1) === '>' ? fresh : ownPending]]),
    );
  }

  type StreamEntry = [string, string[]];
  const entry = (userId: string, saleId = randomUUID()) =>
    [
      `${Date.now()}-${userId}`,
      [
        'saleId',
        saleId,
        'userId',
        userId,
        'timestamp',
        '2026-01-01T00:00:00.000Z',
      ],
    ] as StreamEntry;

  function newDrainer(): OrderOutboxDrainer {
    return new OrderOutboxDrainer(sharedRedis, outboxKey, prisma);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    client.xgroup.mockResolvedValue('OK');
    client.xautoclaim.mockResolvedValue(['0-0', [], []]);
    client.xpending.mockResolvedValue([]);
    client.eval.mockResolvedValue(0);
    stream([], []);
    createMany.mockResolvedValue({ count: 0 });
    pipeline.xpending.mockReturnThis();
    pipeline.exec.mockResolvedValue([]);
  });

  it('reads with a dedicated connection so the blocking read never holds up the shared client', () => {
    newDrainer();

    expect(sharedRedis.duplicate).toHaveBeenCalledTimes(1);
  });

  it('creates the consumer group from the start of the stream, creating the stream if needed', async () => {
    await newDrainer().drainOnce();

    expect(client.xgroup).toHaveBeenCalledWith(
      'CREATE',
      outboxKey,
      ORDER_OUTBOX_GROUP,
      '0',
      'MKSTREAM',
    );
  });

  it('treats an already-existing group as fine and only creates it once', async () => {
    client.xgroup.mockRejectedValue(
      new Error('BUSYGROUP Consumer Group name already exists'),
    );
    const drainer = newDrainer();

    await drainer.drainOnce();
    await drainer.drainOnce();

    expect(client.xgroup).toHaveBeenCalledTimes(1);
    expect(client.xautoclaim).toHaveBeenCalledTimes(2);
  });

  it('propagates any other group-creation failure', async () => {
    client.xgroup.mockRejectedValue(new Error('connection refused'));

    await expect(newDrainer().drainOnce()).rejects.toThrow(
      'connection refused',
    );
  });

  it('retries its own unacknowledged entries before blocking for new ones', async () => {
    const stranded = entry('user-stranded');
    stream([stranded], []);

    await expect(newDrainer().drainOnce()).resolves.toMatchObject({
      handled: 1,
    });

    expect(client.xreadgroup).toHaveBeenNthCalledWith(
      1,
      'GROUP',
      ORDER_OUTBOX_GROUP,
      expect.any(String),
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
      'STREAMS',
      outboxKey,
      '0',
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [row(stranded)],
      skipDuplicates: true,
    });
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      stranded[0],
    );
  });

  it('reads a bounded batch of new entries with a bounded block', async () => {
    await newDrainer().drainOnce();

    expect(client.xreadgroup).toHaveBeenLastCalledWith(
      'GROUP',
      ORDER_OUTBOX_GROUP,
      expect.any(String),
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
      'BLOCK',
      ORDER_OUTBOX_BLOCK_MS,
      'STREAMS',
      outboxKey,
      '>',
    );
  });

  it('writes every entry read to Postgres in one batch, then acks and deletes them', async () => {
    const saleId = randomUUID();
    const one = entry('user-1', saleId);
    const two = entry('user-2', saleId);
    stream([], [one, two]);

    await expect(newDrainer().drainOnce()).resolves.toEqual({
      handled: 2,
      backoffMs: 0,
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [row(one), row(two)],
      skipDuplicates: true,
    });
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      one[0],
      two[0],
    );
    expect(multi.xdel).toHaveBeenCalledWith(outboxKey, one[0], two[0]);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it('acks nothing and touches Postgres not at all when the stream is idle', async () => {
    await expect(newDrainer().drainOnce()).resolves.toEqual({
      handled: 0,
      backoffMs: 0,
    });

    expect(createMany).not.toHaveBeenCalled();
    expect(client.multi).not.toHaveBeenCalled();
  });

  it('leaves every entry pending (no ack) and asks for a backoff when Postgres is down', async () => {
    const one = entry('user-1');
    const two = entry('user-2');
    stream([], [one, two]);
    createMany.mockRejectedValue(new Error('connection refused'));
    deliveries({ [one[0]]: 1, [two[0]]: 1 });

    const result = await newDrainer().drainOnce();

    expect(result.handled).toBe(2);
    within(result.backoffMs, PERSIST_ORDER_BACKOFF_BASE_MS);
    expect(multi.xack).not.toHaveBeenCalled();
    expect(multi.xdel).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to persist Order for sale ${one[1][1]}, user user-1 (attempt 1 of ${PERSIST_ORDER_ATTEMPTS}); outbox entry ${one[0]} left pending`,
      ),
      expect.any(Error),
    );
  });

  it('isolates a poison entry: when the batch fails, retries each entry alone, acks the ones that land and leaves the rest pending', async () => {
    const good = entry('user-good');
    const bad = entry('user-bad');
    stream([], [good, bad]);
    createMany.mockImplementation((({
      data,
    }: {
      data: { userId: string }[];
    }) =>
      data.some((r) => r.userId === 'user-bad')
        ? Promise.reject(new Error('foreign key violation'))
        : Promise.resolve({ count: data.length })) as never);
    deliveries({ [bad[0]]: 1 });

    const result = await newDrainer().drainOnce();

    expect(result.handled).toBe(2);
    expect(result.backoffMs).toBeGreaterThan(0);
    expect(createMany).toHaveBeenCalledWith({
      data: [row(good)],
      skipDuplicates: true,
    });
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      good[0],
    );
    expect(multi.xdel).toHaveBeenCalledWith(outboxKey, good[0]);
    expect(multi.xack).not.toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      bad[0],
    );
  });

  it('backs off exponentially across failed passes and resets once a pass succeeds', async () => {
    const one = entry('user-1');
    stream([one], []);
    createMany.mockRejectedValue(new Error('connection refused'));
    deliveries({});
    const drainer = newDrainer();

    within(
      (await drainer.drainOnce()).backoffMs,
      PERSIST_ORDER_BACKOFF_BASE_MS,
    );
    within(
      (await drainer.drainOnce()).backoffMs,
      PERSIST_ORDER_BACKOFF_BASE_MS * 2,
    );
    within(
      (await drainer.drainOnce()).backoffMs,
      PERSIST_ORDER_BACKOFF_BASE_MS * 4,
    );

    createMany.mockResolvedValue({ count: 1 });
    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 1,
      backoffMs: 0,
    });
  });

  it('never backs off long enough for its pending entries to look abandoned to another drainer', async () => {
    stream([entry('user-1')], []);
    createMany.mockRejectedValue(new Error('connection refused'));
    deliveries({});
    const drainer = newDrainer();

    let backoffMs = 0;
    for (let pass = 0; pass < 10; pass++) {
      ({ backoffMs } = await drainer.drainOnce());
    }

    expect(backoffMs).toBeLessThanOrEqual(ORDER_OUTBOX_CLAIM_IDLE_MS / 2);
    expect(backoffMs).toBeGreaterThan(0);
  });

  it('counts a slow pass (a hung write) against the backoff, since its entries have been idle since the read', async () => {
    vi.useFakeTimers();
    try {
      stream([entry('user-1')], []);
      createMany.mockImplementation((() => {
        vi.advanceTimersByTime(ORDER_OUTBOX_CLAIM_IDLE_MS / 2 - 100);
        return Promise.reject(new Error('timeout'));
      }) as never);
      deliveries({});

      const { backoffMs } = await newDrainer().drainOnce();

      expect(backoffMs).toBeLessThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts backing off from scratch after an idle pass', async () => {
    createMany.mockRejectedValue(new Error('connection refused'));
    deliveries({});
    const drainer = newDrainer();
    stream([entry('user-1')], []);
    await drainer.drainOnce();
    await drainer.drainOnce();

    stream([], []);
    await expect(drainer.drainOnce()).resolves.toEqual({
      handled: 0,
      backoffMs: 0,
    });
    stream([entry('user-2')], []);
    within(
      (await drainer.drainOnce()).backoffMs,
      PERSIST_ORDER_BACKOFF_BASE_MS,
    );
  });

  it(`dead-letters an entry that has failed PERSIST_ORDER_ATTEMPTS times, atomically with its ack, and keeps the others pending`, async () => {
    const saleId = randomUUID();
    const exhausted = entry('user-exhausted', saleId);
    const fresh = entry('user-fresh', saleId);
    stream([exhausted, fresh], []);
    createMany.mockRejectedValue(new Error('connection refused'));
    deliveries({
      [exhausted[0]]: PERSIST_ORDER_ATTEMPTS,
      [fresh[0]]: PERSIST_ORDER_ATTEMPTS - 1,
    });

    await newDrainer().drainOnce();

    expect(multi.xadd).toHaveBeenCalledWith(
      orderOutboxDeadLetterKey(outboxKey),
      '*',
      'saleId',
      saleId,
      'userId',
      'user-exhausted',
      'timestamp',
      '2026-01-01T00:00:00.000Z',
      'attempts',
      String(PERSIST_ORDER_ATTEMPTS),
      'error',
      'connection refused',
    );
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      exhausted[0],
    );
    expect(multi.xdel).toHaveBeenCalledWith(outboxKey, exhausted[0]);
    expect(multi.exec).toHaveBeenCalledTimes(1);
    expect(multi.xadd).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `Order for sale ${saleId}, user user-exhausted DEAD-LETTERED after ${PERSIST_ORDER_ATTEMPTS} attempts`,
      ),
      expect.any(Error),
    );
  });

  it('handles an entry once per pass even if it is both pending and reclaimed', async () => {
    const twice = entry('user-twice');
    stream([twice], []);
    client.xautoclaim.mockResolvedValue(['0-0', [twice], []]);

    await expect(newDrainer().drainOnce()).resolves.toMatchObject({
      handled: 1,
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [row(twice)],
      skipDuplicates: true,
    });
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      twice[0],
    );
  });

  it("reclaims other consumers' entries idle for longer than ORDER_OUTBOX_CLAIM_IDLE_MS", async () => {
    const stranded = entry('user-stranded');
    client.xautoclaim.mockResolvedValue(['0-0', [stranded], []]);

    await expect(newDrainer().drainOnce()).resolves.toMatchObject({
      handled: 1,
    });

    expect(client.xautoclaim).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      expect.any(String),
      ORDER_OUTBOX_CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [row(stranded)],
      skipDuplicates: true,
    });
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      stranded[0],
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('Reclaimed 1 order-outbox entry'),
    );
  });

  it('prunes dead consumers once, when it joins the group', async () => {
    client.eval.mockResolvedValue(2);
    const drainer = newDrainer();

    await drainer.drainOnce();
    await drainer.drainOnce();

    expect(client.eval).toHaveBeenCalledTimes(1);
    expect(client.eval).toHaveBeenCalledWith(
      PRUNE_OUTBOX_CONSUMERS_SCRIPT,
      1,
      outboxKey,
      ORDER_OUTBOX_GROUP,
      ORDER_OUTBOX_CLAIM_IDLE_MS,
      expect.any(String),
    );
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      expect.stringContaining('Removed 2 dead order-outbox consumers'),
    );
  });

  it('removes its own consumer and closes its connection on shutdown', async () => {
    const drainer = newDrainer();

    await drainer.onModuleDestroy();

    expect(client.xpending).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      '-',
      '+',
      1,
      expect.any(String),
    );
    expect(client.xgroup).toHaveBeenCalledWith(
      'DELCONSUMER',
      outboxKey,
      ORDER_OUTBOX_GROUP,
      expect.any(String),
    );
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('keeps its consumer on shutdown while it still holds pending entries, so a live drainer can reclaim them', async () => {
    client.xpending.mockResolvedValue([['1-0', 'me', 5, 1]]);
    const drainer = newDrainer();

    await drainer.onModuleDestroy();

    expect(client.xgroup).not.toHaveBeenCalledWith(
      'DELCONSUMER',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('still closes its connection when removing its consumer fails on shutdown', async () => {
    client.xpending.mockRejectedValue(new Error('connection refused'));
    const drainer = newDrainer();

    await drainer.onModuleDestroy();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'Failed to remove own order-outbox consumer',
      expect.any(Error),
    );
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
