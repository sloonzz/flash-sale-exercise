import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../config/env.js';
import { createTestQueue } from './order-queue.test-support.js';
import { OrderQueueProducer } from './order-queue.producer.js';
import { PERSIST_ORDER_QUEUE } from './persist-order-job.js';

describe('OrderQueueProducer', () => {
  const queue = createTestQueue();
  const producer = new OrderQueueProducer(queue);
  const redis = new Redis(REDIS_URL);
  const jobIds: string[] = [];

  function jobKey(jobId: string): string {
    return `bull:${PERSIST_ORDER_QUEUE}:${jobId}`;
  }

  afterEach(async () => {
    const keys = jobIds.map(jobKey);
    await Promise.all(
      jobIds.map((jobId) =>
        redis.lrem(`bull:${PERSIST_ORDER_QUEUE}:wait`, 0, jobId),
      ),
    );
    jobIds.length = 0;
    if (keys.length > 0) await redis.del(...keys);
  });

  afterAll(async () => {
    await queue.close();
    await redis.quit();
  });

  it('enqueues a job carrying the sale id, user id, and timestamp', async () => {
    const saleId = randomUUID();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    jobIds.push(`${saleId}|user-1`);

    await producer.enqueuePersistOrder(saleId, 'user-1', timestamp);

    const job = await redis.hgetall(jobKey(`${saleId}|user-1`));
    expect(JSON.parse(job.data)).toEqual({
      saleId,
      userId: 'user-1',
      timestamp: timestamp.toISOString(),
    });
  });

  it('does not queue a second job for the same sale and user', async () => {
    const saleId = randomUUID();
    jobIds.push(`${saleId}|user-1`);

    await producer.enqueuePersistOrder(saleId, 'user-1', new Date());
    await producer.enqueuePersistOrder(saleId, 'user-1', new Date());

    await expect(redis.llen(`bull:${PERSIST_ORDER_QUEUE}:wait`)).resolves.toBe(
      1,
    );
  });
});
