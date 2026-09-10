import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../config/env.js';
import { OrderQueueProducer } from '../order/order-queue.producer.js';
import { PERSIST_ORDER_QUEUE } from '../order/persist-order-job.js';
import { reservedUsersKey, stockKey } from './reservation-keys.js';
import { ReservationService } from './reservation.service.js';

describe('ReservationService', () => {
  const orderQueueProducer = new OrderQueueProducer();
  const service = new ReservationService(orderQueueProducer);
  const redis = new Redis(REDIS_URL);
  const saleIds: string[] = [];

  async function freshSale(totalStock: number): Promise<string> {
    const saleId = randomUUID();
    saleIds.push(saleId);
    await service.initializeStock(saleId, totalStock);
    return saleId;
  }

  afterEach(async () => {
    const keys = saleIds.flatMap((saleId) => [
      stockKey(saleId),
      reservedUsersKey(saleId),
    ]);
    if (keys.length > 0) await redis.del(...keys);

    // Scoped by this file's own sale ids (random UUIDs, never reused across
    // spec files) so this cleanup can't race with order-queue.producer.spec.ts
    // running its own assertions against the same queue concurrently.
    const jobKeyLists = await Promise.all(
      saleIds.map((saleId) =>
        redis.keys(`bull:${PERSIST_ORDER_QUEUE}:${saleId}|*`),
      ),
    );
    const jobKeys = jobKeyLists.flat();
    if (jobKeys.length > 0) await redis.del(...jobKeys);
    const prefix = `bull:${PERSIST_ORDER_QUEUE}:`;
    await Promise.all(
      jobKeys.map((key) =>
        redis.lrem(
          `bull:${PERSIST_ORDER_QUEUE}:wait`,
          0,
          key.slice(prefix.length),
        ),
      ),
    );

    saleIds.length = 0;
  });

  afterAll(async () => {
    await service.onModuleDestroy();
    await orderQueueProducer.onModuleDestroy();
    await redis.quit();
  });

  it('succeeds for a user purchasing for the first time', async () => {
    const saleId = await freshSale(1);

    await expect(service.reserve(saleId, 'user-1')).resolves.toBe('success');
  });

  it('rejects a second attempt by the same user', async () => {
    const saleId = await freshSale(5);

    await expect(service.reserve(saleId, 'user-1')).resolves.toBe('success');
    await expect(service.reserve(saleId, 'user-1')).resolves.toBe(
      'already_purchased',
    );
  });

  it('rejects a purchase attempt after stock has hit zero', async () => {
    const saleId = await freshSale(0);

    await expect(service.reserve(saleId, 'user-1')).resolves.toBe('sold_out');
  });

  it('never oversells past the configured stock under concurrent load', async () => {
    const totalStock = 10;
    const attempts = 50;
    const saleId = await freshSale(totalStock);

    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        service.reserve(saleId, `user-${i}`),
      ),
    );

    const successes = results.filter((result) => result === 'success');
    const soldOut = results.filter((result) => result === 'sold_out');

    expect(successes).toHaveLength(totalStock);
    expect(soldOut).toHaveLength(attempts - totalStock);
    await expect(redis.get(stockKey(saleId))).resolves.toBe('0');
  });

  it('reports already_purchased, not sold_out, for a repeat buyer once the sale is sold out', async () => {
    const saleId = await freshSale(1);

    await expect(service.reserve(saleId, 'user-1')).resolves.toBe('success');
    // Stock is now 0, and user-1 already holds the sale's only Reservation.
    await expect(service.reserve(saleId, 'user-1')).resolves.toBe(
      'already_purchased',
    );
    await expect(service.reserve(saleId, 'user-2')).resolves.toBe('sold_out');
  });

  it('grants exactly one success when the same user calls concurrently', async () => {
    const saleId = await freshSale(5);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.reserve(saleId, 'user-1')),
    );

    expect(results.filter((result) => result === 'success')).toHaveLength(1);
    expect(
      results.filter((result) => result === 'already_purchased'),
    ).toHaveLength(19);
  });

  it('enqueues a persist-order job for a successful reservation', async () => {
    const saleId = await freshSale(1);

    await service.reserve(saleId, 'user-1');

    const job = await redis.hgetall(
      `bull:${PERSIST_ORDER_QUEUE}:${saleId}|user-1`,
    );
    const data = JSON.parse(job.data);
    expect(data).toMatchObject({ saleId, userId: 'user-1' });
  });

  it('does not enqueue a persist-order job for a rejected reservation', async () => {
    const saleId = await freshSale(0);

    await service.reserve(saleId, 'user-1');

    await expect(
      redis.exists(`bull:${PERSIST_ORDER_QUEUE}:${saleId}|user-1`),
    ).resolves.toBe(0);
  });
});
