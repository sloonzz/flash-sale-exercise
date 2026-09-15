import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { REDIS_URL } from '../src/config/env.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../src/reservation/reservation-keys.ts';
import { RESERVE_SCRIPT } from '../src/reservation/reserve-script.ts';
import { SPIKE_CONNECTIONS } from './support/config.ts';

describe('RESERVE_SCRIPT ceiling (single Redis instance, no HTTP/Nest/Postgres)', () => {
  const redis = new Redis(REDIS_URL);
  const outboxKey = `order-outbox-perf-${randomUUID()}`;
  const saleIds: string[] = [];

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

  it(`sustains ${SPIKE_CONNECTIONS} concurrent unique-user EVALs with zero oversell`, async () => {
    const saleId = randomUUID();
    saleIds.push(saleId);

    const initialStock = SPIKE_CONNECTIONS * 10;
    await redis.set(stockKey(saleId), initialStock);

    const start = performance.now();
    const results = await Promise.all(
      Array.from({ length: SPIKE_CONNECTIONS }, (_, i) =>
        redis.eval(
          RESERVE_SCRIPT,
          3,
          stockKey(saleId),
          reservedUsersKey(saleId),
          outboxKey,
          `user-${i}`,
          saleId,
          new Date().toISOString(),
        ),
      ),
    );
    const durationMs = performance.now() - start;

    const successes = results.filter((result) => result === 'success');
    expect(successes).toHaveLength(SPIKE_CONNECTIONS);

    const remainingStock = await redis.get(stockKey(saleId));
    expect(Number(remainingStock)).toBe(initialStock - SPIKE_CONNECTIONS);
    await expect(redis.xlen(outboxKey)).resolves.toBe(SPIKE_CONNECTIONS);

    const opsPerSec = (SPIKE_CONNECTIONS / durationMs) * 1000;
    console.log(
      `RESERVE_SCRIPT ceiling: ${opsPerSec.toFixed(0)} ops/sec ` +
        `(${SPIKE_CONNECTIONS} concurrent unique-user EVALs against a single ` +
        `Redis instance, ${durationMs.toFixed(1)}ms total).`,
    );
  });
});
