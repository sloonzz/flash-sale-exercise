import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../config/env.js';
import { createTestQueue } from './order-queue.test-support.js';
import { OrderQueueProducer } from './order-queue.producer.js';

describe('OrderQueueProducer (integration)', () => {
  const queue = createTestQueue();
  const producer = new OrderQueueProducer(queue);
  const redis = new Redis(REDIS_URL);

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });

  it('does not queue a second job for the same sale and user', async () => {
    const saleId = randomUUID();

    await producer.enqueuePersistOrder(saleId, 'user-1', new Date());
    await producer.enqueuePersistOrder(saleId, 'user-1', new Date());

    await expect(redis.llen(`bull:${queue.name}:wait`)).resolves.toBe(1);
  });
});
