import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../src/config/env.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../src/reservation/reservation-keys.ts';
import { RESERVE_SCRIPT } from '../src/reservation/reserve-script.ts';
import { CONCURRENT_SPIKE_USERS } from './support/config.ts';

describe('RESERVE_SCRIPT ceiling (single Redis instance, no HTTP/Nest/Postgres/BullMQ)', () => {
  const redis = new Redis(REDIS_URL);
  const saleIds: string[] = [];

  afterEach(async () => {
    const keys = saleIds.flatMap((saleId) => [
      stockKey(saleId),
      reservedUsersKey(saleId),
    ]);
    if (keys.length > 0) await redis.del(...keys);
    saleIds.length = 0;
  });

  afterAll(async () => {
    await redis.quit();
  });

  it(`sustains ${CONCURRENT_SPIKE_USERS} concurrent unique-user EVALs with zero oversell`, async () => {
    const saleId = randomUUID();
    saleIds.push(saleId);

    const initialStock = CONCURRENT_SPIKE_USERS * 10;
    await redis.set(stockKey(saleId), initialStock);

    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_SPIKE_USERS }, (_, i) =>
        redis.eval(
          RESERVE_SCRIPT,
          2,
          stockKey(saleId),
          reservedUsersKey(saleId),
          `user-${i}`,
        ),
      ),
    );
    const durationMs = performance.now() - start;

    const successes = results.filter((result) => result === 'success');
    expect(successes).toHaveLength(CONCURRENT_SPIKE_USERS);

    const remainingStock = await redis.get(stockKey(saleId));
    expect(Number(remainingStock)).toBe(initialStock - CONCURRENT_SPIKE_USERS);

    const opsPerSec = (CONCURRENT_SPIKE_USERS / durationMs) * 1000;
    console.log(
      `RESERVE_SCRIPT ceiling: ${opsPerSec.toFixed(0)} ops/sec ` +
        `(${CONCURRENT_SPIKE_USERS} concurrent unique-user EVALs against a single ` +
        `Redis instance, ${durationMs.toFixed(1)}ms total).`,
    );
  });
});
