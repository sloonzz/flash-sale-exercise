import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ORDER_OUTBOX_CLAIM_IDLE_MS } from '../config/env.ts';
import {
  ORDER_OUTBOX_BATCH_SIZE,
  ORDER_OUTBOX_BLOCK_MS,
  OrderOutboxDrainer,
} from './order-outbox.drainer.ts';
import { ORDER_OUTBOX_GROUP } from './order-outbox.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';
import { PRUNE_OUTBOX_CONSUMERS_SCRIPT } from './prune-outbox-consumers-script.ts';

describe('OrderOutboxDrainer', () => {
  const outboxKey = 'order-outbox-test';
  const multi = {
    xack: vi.fn().mockReturnThis(),
    xdel: vi.fn().mockReturnThis(),
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
  };
  const sharedRedis = { duplicate: vi.fn(() => client) } as unknown as Redis;
  const orderQueueProducer = {
    enqueuePersistOrder: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrderQueueProducer;

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
    return new OrderOutboxDrainer(sharedRedis, outboxKey, orderQueueProducer);
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
    vi.mocked(orderQueueProducer.enqueuePersistOrder).mockResolvedValue(
      undefined,
    );
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

    await expect(newDrainer().drainOnce()).resolves.toBe(1);

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
    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
      stranded[1][1],
      'user-stranded',
      expect.any(Date),
    );
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

  it('enqueues a persist-order job for every entry read, then acks and deletes them', async () => {
    const saleId = randomUUID();
    const one = entry('user-1', saleId);
    const two = entry('user-2', saleId);
    stream([], [one, two]);

    await expect(newDrainer().drainOnce()).resolves.toBe(2);

    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledTimes(2);
    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
      saleId,
      'user-1',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
      saleId,
      'user-2',
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      one[0],
      two[0],
    );
    expect(multi.xdel).toHaveBeenCalledWith(outboxKey, one[0], two[0]);
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it('acks nothing and touches no queue when the stream is idle', async () => {
    await expect(newDrainer().drainOnce()).resolves.toBe(0);

    expect(orderQueueProducer.enqueuePersistOrder).not.toHaveBeenCalled();
    expect(client.multi).not.toHaveBeenCalled();
  });

  it('leaves an entry pending (no ack) when its enqueue fails, and still acks the others', async () => {
    const good = entry('user-good');
    const bad = entry('user-bad');
    stream([], [good, bad]);
    vi.mocked(orderQueueProducer.enqueuePersistOrder).mockImplementation(
      (_saleId, userId) =>
        userId === 'user-bad'
          ? Promise.reject(new Error('queue unavailable'))
          : Promise.resolve(),
    );

    await expect(newDrainer().drainOnce()).resolves.toBe(2);

    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      good[0],
    );
    expect(multi.xdel).toHaveBeenCalledWith(outboxKey, good[0]);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining(`outbox entry ${bad[0]} left pending`),
      expect.any(Error),
    );
  });

  it('handles an entry once per pass even if it is both pending and reclaimed', async () => {
    const twice = entry('user-twice');
    stream([twice], []);
    client.xautoclaim.mockResolvedValue(['0-0', [twice], []]);

    await expect(newDrainer().drainOnce()).resolves.toBe(1);

    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledTimes(1);
    expect(multi.xack).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      twice[0],
    );
  });

  it("reclaims other consumers' entries idle for longer than ORDER_OUTBOX_CLAIM_IDLE_MS", async () => {
    const stranded = entry('user-stranded');
    client.xautoclaim.mockResolvedValue(['0-0', [stranded], []]);

    await expect(newDrainer().drainOnce()).resolves.toBe(1);

    expect(client.xautoclaim).toHaveBeenCalledWith(
      outboxKey,
      ORDER_OUTBOX_GROUP,
      expect.any(String),
      ORDER_OUTBOX_CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      ORDER_OUTBOX_BATCH_SIZE,
    );
    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
      stranded[1][1],
      'user-stranded',
      expect.any(Date),
    );
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
