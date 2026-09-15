import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../../config/env.ts';
import { OrderOutboxService } from './order-outbox.service.ts';
import {
  orderOutboxDeadLetterKey,
  parseOrderOutboxEntry,
} from './order-outbox.ts';

describe('OrderOutboxService (integration)', () => {
  const redis = new Redis(REDIS_URL);
  let outboxKey: string;
  let outbox: OrderOutboxService;

  beforeEach(() => {
    outboxKey = `order-outbox-test-${randomUUID()}`;
    outbox = new OrderOutboxService(redis, outboxKey);
  });

  afterEach(async () => {
    await redis.del(outboxKey, orderOutboxDeadLetterKey(outboxKey));
  });

  afterAll(async () => {
    await redis.quit();
  });

  async function outboxEntries() {
    const entries = await redis.xrange(outboxKey, '-', '+');
    return entries.map(([id, fields]) => parseOrderOutboxEntry(id, fields));
  }

  async function deadLetter(saleId: string, userId: string): Promise<void> {
    await redis.xadd(
      orderOutboxDeadLetterKey(outboxKey),
      '*',
      'saleId',
      saleId,
      'userId',
      userId,
      'timestamp',
      '2026-01-01T00:00:00.000Z',
      'attempts',
      '50',
      'error',
      'connection refused',
    );
  }

  it('appends an entry the drainer will persist an Order for', async () => {
    const saleId = randomUUID();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await outbox.append(saleId, 'user-1', timestamp);

    await expect(outboxEntries()).resolves.toEqual([
      expect.objectContaining({
        saleId,
        userId: 'user-1',
        timestamp: timestamp.toISOString(),
      }),
    ]);
  });

  it('lists the users whose Order was dead-lettered for the given sale, and only that sale', async () => {
    const saleId = randomUUID();
    await deadLetter(saleId, 'user-1');
    await deadLetter(randomUUID(), 'user-2');
    await deadLetter(saleId, 'user-3');

    await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([
      'user-1',
      'user-3',
    ]);
    await expect(outbox.listDeadLettered(randomUUID())).resolves.toEqual([]);
  });

  it('replays a dead-lettered entry back into the outbox so it is retried from scratch', async () => {
    const saleId = randomUUID();
    await deadLetter(saleId, 'user-1');
    await deadLetter(saleId, 'user-2');

    await expect(outbox.replayDeadLettered(saleId, 'user-1')).resolves.toBe(
      true,
    );

    await expect(outboxEntries()).resolves.toEqual([
      expect.objectContaining({
        saleId,
        userId: 'user-1',
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    await expect(outbox.listDeadLettered(saleId)).resolves.toEqual(['user-2']);
  });

  it('replays nothing when the user has no dead-lettered entry', async () => {
    await expect(
      outbox.replayDeadLettered(randomUUID(), 'user-1'),
    ).resolves.toBe(false);

    await expect(outboxEntries()).resolves.toEqual([]);
  });
});
