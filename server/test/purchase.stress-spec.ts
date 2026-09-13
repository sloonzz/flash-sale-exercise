import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import autocannon from 'autocannon';
import { Queue } from 'bullmq';
import type { PurchaseResult } from 'common';
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
  CLIENT_SHARDS,
  CLUSTER_WORKERS,
  CONCURRENT_USERS,
} from './support/stress-config.ts';

const execFileAsync = promisify(execFile);
const CLIENT_SCRIPT = fileURLToPath(
  new URL('./support/autocannon-client.ts', import.meta.url),
);

const ADMIN_KEY = 'test-admin-key';

const TOTAL_STOCK = Number(process.env.STRESS_STOCK ?? 50);

if (TOTAL_STOCK >= CONCURRENT_USERS) {
  throw new Error(
    `STRESS_STOCK (${TOTAL_STOCK}) must be less than STRESS_USERS (${CONCURRENT_USERS}) -- this suite exists to prove the reservation never oversells when demand exceeds stock.`,
  );
}

type PurchaseResultOrNull = PurchaseResult | null;

// Runs against a real, clustered server process (see clustered-server.ts)
// rather than an in-process Nest TestingModule, so the suite exercises
// cluster.fork() and matches how the service actually runs in production.
describe(`Purchase under load (stress, CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
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
      THROTTLE_LIMIT: String(CONCURRENT_USERS * 2),
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

  // Splits `amount` across CLIENT_SHARDS parallel client processes so the
  // load generator's own single-process connection-opening pace doesn't
  // become the bottleneck being measured.
  async function fireConcurrentPurchases(
    amount: number,
    userIds: 'unique' | 'duplicate',
    saleId: string,
  ): Promise<{
    results: Array<PurchaseResultOrNull>;
    runResults: autocannon.Result[];
  }> {
    const baseShardAmount = Math.floor(amount / CLIENT_SHARDS);
    let userIdOffset = 0;
    const shardAmounts = Array.from({ length: CLIENT_SHARDS }, (_, i) =>
      i === CLIENT_SHARDS - 1
        ? amount - baseShardAmount * (CLIENT_SHARDS - 1)
        : baseShardAmount,
    );

    const shardResults = await Promise.all(
      shardAmounts.map(async (shardAmount) => {
        const config = JSON.stringify({
          url: server.baseUrl,
          amount: shardAmount,
          saleId,
          userIds,
          userIdOffset,
        });
        userIdOffset += shardAmount;

        const { stdout } = await execFileAsync(
          process.execPath,
          [CLIENT_SCRIPT, config],
          { maxBuffer: 64 * 1024 * 1024 },
        );

        return JSON.parse(stdout) as {
          results: Array<PurchaseResultOrNull>;
          runResult: autocannon.Result;
        };
      }),
    );

    return {
      results: shardResults.flatMap((shard) => shard.results),
      runResults: shardResults.map((shard) => shard.runResult),
    };
  }

  it(`grants exactly ${TOTAL_STOCK} of ${CONCURRENT_USERS} concurrent unique-user purchases, with zero oversell`, async () => {
    const saleId = await createSale(TOTAL_STOCK);

    const { results, runResults } = await fireConcurrentPurchases(
      CONCURRENT_USERS,
      'unique',
      saleId,
    );

    expect(results).toHaveLength(CONCURRENT_USERS);
    expect(results.every((result) => result !== null)).toBe(true);

    const successes = results.filter((result) => result === 'success');
    expect(successes).toHaveLength(TOTAL_STOCK);

    await expect(redis.get(stockKey(saleId))).resolves.toBe('0');

    // Wait for the async BullMQ consumer to persist the order data
    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(TOTAL_STOCK);

    const distinctUsers = await prisma.order.findMany({
      where: { saleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(distinctUsers).toHaveLength(TOTAL_STOCK);

    runResults.forEach((runResult) =>
      console.log(autocannon.printResult(runResult)),
    );
  });

  it(`grants all ${CONCURRENT_USERS} concurrent unique-user purchases when stock far exceeds demand`, async () => {
    const abundantStock = CONCURRENT_USERS * 10;
    const saleId = await createSale(abundantStock);

    const { results, runResults } = await fireConcurrentPurchases(
      CONCURRENT_USERS,
      'unique',
      saleId,
    );

    runResults.forEach((runResult, index) =>
      console.log(
        `shard ${index}: errors=${runResult.errors} timeouts=${runResult.timeouts} non2xx=${runResult.non2xx}`,
      ),
    );

    expect(results).toHaveLength(CONCURRENT_USERS);
    expect(results.every((result) => result !== null)).toBe(true);

    const successes = results.filter((result) => result === 'success');
    expect(successes).toHaveLength(CONCURRENT_USERS);

    await expect(redis.get(stockKey(saleId))).resolves.toBe(
      String(abundantStock - CONCURRENT_USERS),
    );

    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(CONCURRENT_USERS);

    const distinctUsers = await prisma.order.findMany({
      where: { saleId },
      select: { userId: true },
      distinct: ['userId'],
    });
    expect(distinctUsers).toHaveLength(CONCURRENT_USERS);

    runResults.forEach((runResult) =>
      console.log(autocannon.printResult(runResult)),
    );
  });

  it(`grants exactly 1 of ${CONCURRENT_USERS} concurrent purchase attempts from the same user`, async () => {
    const saleId = await createSale(CONCURRENT_USERS);

    const { results, runResults } = await fireConcurrentPurchases(
      CONCURRENT_USERS,
      'duplicate',
      saleId,
    );

    expect(results).toHaveLength(CONCURRENT_USERS);
    expect(results.every((result) => result !== null)).toBe(true);

    const successes = results.filter((result) => result === 'success');
    const alreadyPurchased = results.filter(
      (result) => result === 'already_purchased',
    );
    expect(successes).toHaveLength(1);
    expect(alreadyPurchased).toHaveLength(CONCURRENT_USERS - 1);

    await expect
      .poll(() => prisma.order.count({ where: { saleId } }), {
        timeout: 60_000,
        interval: 100,
      })
      .toBe(1);

    runResults.forEach((runResult) =>
      console.log(autocannon.printResult(runResult)),
    );
  });
});
