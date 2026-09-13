import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import autocannon from 'autocannon';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, REDIS_URL } from '../src/config/env.ts';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { BULL_REDIS_CONNECTION } from '../src/order/bull-connection.ts';
import { PERSIST_ORDER_QUEUE } from '../src/order/persist-order-job.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../src/reservation/reservation-keys.ts';
import { currentSaleKey } from '../src/sale/sale-cache.ts';
import {
  startClusteredServer,
  type ClusteredServer,
} from './support/clustered-server.ts';
import {
  AUTOCANNON_WORKERS,
  CLUSTER_WORKERS,
  CONCURRENT_SPIKE_USERS,
} from './support/config.ts';

const SETUP_REQUEST_SCRIPT = fileURLToPath(
  new URL('./support/purchase-setup-request.cjs', import.meta.url),
);

const ADMIN_KEY = 'test-admin-key';

const UNDERSTOCKED_STOCK = Number(process.env.UNDERSTOCKED_STOCK ?? 50);

if (UNDERSTOCKED_STOCK >= CONCURRENT_SPIKE_USERS) {
  throw new Error(
    `UNDERSTOCKED_STOCK (${UNDERSTOCKED_STOCK}) must be less than STRESS_USERS (${CONCURRENT_SPIKE_USERS}) -- this suite exists to prove the reservation never oversells when demand exceeds stock.`,
  );
}

describe(`Purchase under spike load (CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
  let server: ClusteredServer;
  const redis = new Redis(REDIS_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }),
  });
  const persistOrderQueue = new Queue(PERSIST_ORDER_QUEUE, {
    connection: BULL_REDIS_CONNECTION,
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
    await expect
      .poll(
        async () => {
          const counts = await persistOrderQueue.getJobCounts(
            'waiting',
            'active',
            'delayed',
          );
          return counts.waiting + counts.active + counts.delayed;
        },
        { timeout: 60_000, interval: 100 },
      )
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
    await persistOrderQueue.close();
    await prisma.$disconnect();
    await redis.quit();
  });

  async function createSale(totalStock: number): Promise<string> {
    const now = Date.now();
    const response = await fetch(`${server.baseUrl}/admin/sales`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': ADMIN_KEY,
      },
      body: JSON.stringify({
        productName: 'Stress Test Widget',
        totalStock,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now + 5 * 60_000).toISOString(),
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string };
    saleIds.push(body.id);
    return body.id;
  }

  function fireConcurrentPurchases(
    amount: number,
    userIds: 'unique' | 'duplicate',
    saleId: string,
  ): Promise<autocannon.Result> {
    return new Promise((resolve, reject) => {
      autocannon(
        {
          url: server.baseUrl,
          // Spike test: every connection fires exactly one purchase attempt,
          // mirroring a real user hitting "buy" once when the sale opens
          connections: amount,
          amount,
          duration: 15,
          workers: AUTOCANNON_WORKERS,
          initialContext: { saleId, userIds },
          requests: [
            {
              method: 'POST',
              setupRequest: SETUP_REQUEST_SCRIPT,
            },
          ],
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

  it(`grants exactly ${UNDERSTOCKED_STOCK} of ${CONCURRENT_SPIKE_USERS} concurrent unique-user purchases, with zero oversell`, async () => {
    const saleId = await createSale(UNDERSTOCKED_STOCK);

    const runResult = await fireConcurrentPurchases(
      CONCURRENT_SPIKE_USERS,
      'unique',
      saleId,
    );

    await expect(redis.get(stockKey(saleId))).resolves.toBe('0');

    // Wait for the async BullMQ consumer to persist the order data
    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(UNDERSTOCKED_STOCK);

    const distinctUsers = await prisma.order.findMany({
      where: { saleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(distinctUsers).toHaveLength(UNDERSTOCKED_STOCK);

    console.log(autocannon.printResult(runResult));
  });

  it(`grants all ${CONCURRENT_SPIKE_USERS} concurrent unique-user purchases when stock far exceeds demand`, async () => {
    const abundantStock = CONCURRENT_SPIKE_USERS * 10;
    const saleId = await createSale(abundantStock);

    const runResult = await fireConcurrentPurchases(
      CONCURRENT_SPIKE_USERS,
      'unique',
      saleId,
    );

    await expect(redis.get(stockKey(saleId))).resolves.toBe(
      String(abundantStock - CONCURRENT_SPIKE_USERS),
    );

    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(CONCURRENT_SPIKE_USERS);

    const distinctUsers = await prisma.order.findMany({
      where: { saleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(distinctUsers).toHaveLength(CONCURRENT_SPIKE_USERS);

    console.log(autocannon.printResult(runResult));
  });

  it(`grants exactly 1 of ${CONCURRENT_SPIKE_USERS} concurrent purchase attempts from the same user`, async () => {
    const saleId = await createSale(CONCURRENT_SPIKE_USERS);

    const runResult = await fireConcurrentPurchases(
      CONCURRENT_SPIKE_USERS,
      'duplicate',
      saleId,
    );

    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(1);

    console.log(autocannon.printResult(runResult));
  });
});
