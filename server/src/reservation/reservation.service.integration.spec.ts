import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../config/env.ts';
import { parseOrderOutboxEntry } from '../order/order-outbox.ts';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { ReservationService } from './reservation.service.ts';

describe('ReservationService (integration)', () => {
  const redis = new Redis(REDIS_URL);
  const outboxKey = `order-outbox-test-${randomUUID()}`;
  const service = new ReservationService(redis, outboxKey);
  const saleIds: string[] = [];

  async function freshSale(totalStock: number): Promise<string> {
    const saleId = randomUUID();
    saleIds.push(saleId);
    await service.initializeStock(saleId, totalStock);
    return saleId;
  }

  async function outboxEntries() {
    const entries = await redis.xrange(outboxKey, '-', '+');
    return entries.map(([id, fields]) => parseOrderOutboxEntry(id, fields));
  }

  afterEach(async () => {
    const keys = saleIds.flatMap((saleId) => [
      stockKey(saleId),
      reservedUsersKey(saleId),
    ]);
    await redis.del(outboxKey, ...keys);
    saleIds.length = 0;
  });

  afterAll(async () => {
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

  describe('order outbox', () => {
    it('appends one outbox entry per successful reservation, in the same script call', async () => {
      const saleId = await freshSale(5);
      const before = Date.now();

      await service.reserve(saleId, 'user-1');
      await service.reserve(saleId, 'user-2');

      const entries = await outboxEntries();
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.userId)).toEqual([
        'user-1',
        'user-2',
      ]);
      for (const entry of entries) {
        expect(entry.saleId).toBe(saleId);
        expect(new Date(entry.timestamp).getTime()).toBeGreaterThanOrEqual(
          before,
        );
      }
    });

    it('appends nothing for a rejected reservation', async () => {
      const saleId = await freshSale(1);
      await service.reserve(saleId, 'user-1');

      await service.reserve(saleId, 'user-1'); // already_purchased
      await service.reserve(saleId, 'user-2'); // sold_out

      const entries = await outboxEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe('user-1');
    });

    it('writes exactly as many outbox entries as units sold under concurrent load', async () => {
      const totalStock = 10;
      const saleId = await freshSale(totalStock);

      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          service.reserve(saleId, `user-${i}`),
        ),
      );

      const entries = await outboxEntries();
      expect(entries).toHaveLength(totalStock);
      expect(new Set(entries.map((entry) => entry.userId)).size).toBe(
        totalStock,
      );
      await expect(redis.smembers(reservedUsersKey(saleId))).resolves.toEqual(
        expect.arrayContaining(entries.map((entry) => entry.userId)),
      );
    });
  });
});
