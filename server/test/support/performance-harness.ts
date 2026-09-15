import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { DATABASE_URL, REDIS_URL } from '../../src/config/env.ts';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { ORDER_OUTBOX_DEFAULT_KEY } from '../../src/order/outbox/order-outbox.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
import { currentSaleKey } from '../../src/sale/sale-cache.ts';
import {
  startClusteredServer,
  type ClusteredServer,
} from './clustered-server.ts';
import {
  AUTOCANNON_WORKERS,
  CLUSTER_WORKERS,
  SETTLE_GRACE_MS,
  SETTLE_ORDERS_PER_SECOND,
  type LoadProfile,
} from './config.ts';

const SETUP_REQUEST_SCRIPT = fileURLToPath(
  new URL('./purchase-setup-request.cjs', import.meta.url),
);

export const ADMIN_KEY = 'test-admin-key';

/** Poll options for waiting on `backlog` orders to drain through the persist pipeline. */
export function settlePoll(backlog: number): {
  timeout: number;
  interval: number;
} {
  return {
    timeout:
      SETTLE_GRACE_MS + Math.ceil((backlog / SETTLE_ORDERS_PER_SECOND) * 1000),
    interval: 100,
  };
}

export type PurchaseUserIds = 'unique' | 'duplicate';

export interface PerformanceHarness {
  readonly redis: Redis;
  readonly prisma: PrismaClient;
  createSale(productName: string, totalStock: number): Promise<string>;
  firePurchases(
    profile: LoadProfile,
    userIds: PurchaseUserIds,
    saleId: string,
  ): Promise<autocannon.Result>;
  fireStatusFetches(profile: LoadProfile): Promise<autocannon.Result>;
  expectPersistedOrders(saleId: string, count: number): Promise<void>;
  countDistinctBuyers(saleId: string): Promise<number>;
}

export function usePerformanceHarness(): PerformanceHarness {
  let server: ClusteredServer;
  const redis = new Redis(REDIS_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  const saleIds: string[] = [];

  beforeAll(async () => {
    server = await startClusteredServer({
      ADMIN_KEY,
      CLUSTER_WORKERS: String(CLUSTER_WORKERS),
      DISABLE_THROTTLE: 'true',
    });
  }, 60_000);

  // An entry stays in the stream until its Order row is in Postgres
  function persistBacklog(): Promise<number> {
    return redis.xlen(ORDER_OUTBOX_DEFAULT_KEY);
  }

  afterEach(async () => {
    await expect
      .poll(persistBacklog, settlePoll(await persistBacklog()))
      .toBe(0);

    const keys = saleIds.flatMap((saleId) => [
      stockKey(saleId),
      reservedUsersKey(saleId),
    ]);
    keys.push(currentSaleKey());
    await redis.del(...keys);
    await prisma.order.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    server.stop();
    await prisma.$disconnect();
    await redis.quit();
  });

  function run(
    profile: LoadProfile,
    options: Omit<
      autocannon.Options,
      'url' | 'connections' | 'duration' | 'workers'
    >,
  ): Promise<autocannon.Result> {
    return new Promise((resolve, reject) => {
      autocannon(
        {
          ...options,
          url: server.baseUrl,
          connections: profile.connections,
          duration: profile.durationSeconds,
          workers: AUTOCANNON_WORKERS,
        },
        (err, result) => {
          try {
            if (err) throw err;
            expect(result.errors).toBe(0);
            expect(result.timeouts).toBe(0);
            expect(result.non2xx).toBe(0);
            expect(result['2xx']).toBeGreaterThanOrEqual(profile.connections);
            expect(result['2xx']).toBe(result.requests.total);
            resolve(result);
          } catch (assertionError) {
            reject(assertionError);
          }
        },
      );
    });
  }

  return {
    redis,
    prisma,

    async createSale(productName, totalStock) {
      const now = Date.now();
      const response = await fetch(`${server.baseUrl}/admin/sales`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-key': ADMIN_KEY,
        },
        body: JSON.stringify({
          productName,
          totalStock,
          startTime: new Date(now - 60_000).toISOString(),
          endTime: new Date(now + 5 * 60_000).toISOString(),
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { id: string };
      saleIds.push(body.id);
      return body.id;
    },

    firePurchases(profile, userIds, saleId) {
      return run(profile, {
        initialContext: { saleId, userIds },
        requests: [{ method: 'POST', setupRequest: SETUP_REQUEST_SCRIPT }],
      });
    },

    fireStatusFetches(profile) {
      return run(profile, {
        requests: [{ method: 'GET', path: '/sale/status' }],
      });
    },

    async expectPersistedOrders(saleId, count) {
      await expect
        .poll(
          () => prisma.order.count({ where: { saleId } }),
          settlePoll(count),
        )
        .toBe(count);
    },

    async countDistinctBuyers(saleId) {
      const buyers = await prisma.order.findMany({
        where: { saleId },
        select: { userId: true },
        distinct: ['userId'],
      });
      return buyers.length;
    },
  };
}
