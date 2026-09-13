import { PrismaPg } from '@prisma/adapter-pg';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, REDIS_URL } from '../src/config/env.ts';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { stockKey } from '../src/reservation/reservation-keys.ts';
import { currentSaleKey, deserializeSale } from '../src/sale/sale-cache.ts';
import {
  startClusteredServer,
  type ClusteredServer,
} from './support/clustered-server.ts';
import {
  AUTOCANNON_WORKERS,
  CLUSTER_WORKERS,
  CONCURRENT_SPIKE_USERS,
} from './support/config.ts';

const ADMIN_KEY = 'test-admin-key';

describe(`GET /sale/status under spike load (CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
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

  afterEach(async () => {
    const keys = saleIds.map((saleId) => stockKey(saleId));
    keys.push(currentSaleKey());
    await redis.del(...keys);
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    server.stop();
    await prisma.$disconnect();
    await redis.quit();
  });

  async function createActiveSale(): Promise<string> {
    const now = Date.now();
    const response = await fetch(`${server.baseUrl}/admin/sales`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': ADMIN_KEY,
      },
      body: JSON.stringify({
        productName: 'Sale Status Spike Widget',
        totalStock: 1000,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now + 5 * 60_000).toISOString(),
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    saleIds.push(body.id);
    return body.id;
  }

  function fireConcurrentStatusFetches(
    amount: number,
  ): Promise<autocannon.Result> {
    return new Promise((resolve, reject) => {
      autocannon(
        {
          url: server.baseUrl,
          // Spike test: every connection fires exactly one status check,
          // mirroring a burst of users all loading the sale page at once
          // the moment it opens
          connections: amount,
          amount,
          duration: 15,
          workers: AUTOCANNON_WORKERS,
          requests: [{ method: 'GET', path: '/sale/status' }],
        },
        (err, result) => {
          try {
            if (err) throw err;
            expect(result.errors).toBe(0);
            expect(result.timeouts).toBe(0);
            expect(result.non2xx).toBe(0);
            expect(result['2xx']).toBe(amount);
            resolve(result);
          } catch (assertionError) {
            reject(assertionError);
          }
        },
      );
    });
  }

  it(`answers ${CONCURRENT_SPIKE_USERS} concurrent GET /sale/status requests correctly in a single burst`, async () => {
    const saleId = await createActiveSale();

    const runResult = await fireConcurrentStatusFetches(CONCURRENT_SPIKE_USERS);

    const cached = await redis.get(currentSaleKey());
    expect(cached).not.toBeNull();
    expect(deserializeSale(cached!).id).toBe(saleId);

    const statusResponse = await fetch(`${server.baseUrl}/sale/status`);
    const statusBody = (await statusResponse.json()) as {
      id?: string;
      status?: string;
    };
    expect(statusBody.id).toBe(saleId);
    expect(statusBody.status).toBe('active');

    console.log(autocannon.printResult(runResult));
  });
});
