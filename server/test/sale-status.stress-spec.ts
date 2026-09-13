import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, REDIS_URL } from '../src/config/env.ts';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { stockKey } from '../src/reservation/reservation-keys.ts';
import { currentSaleKey } from '../src/sale/sale-cache.ts';
import {
  startClusteredServer,
  type ClusteredServer,
} from './support/clustered-server.ts';

const execFileAsync = promisify(execFile);
const CLIENT_SCRIPT = fileURLToPath(
  new URL('./support/sale-status-autocannon-client.ts', import.meta.url),
);

const ADMIN_KEY = 'test-admin-key';
const CONCURRENT_USERS = Number(process.env.STRESS_USERS ?? 250);
const CLIENT_SHARDS = Number(process.env.STRESS_CLIENT_SHARDS ?? 4);
const CLUSTER_WORKERS = Number(process.env.CLUSTER_WORKERS ?? 4);

// Runs against a real, clustered server process (see clustered-server.ts)
// rather than an in-process Nest TestingModule, so the suite matches how
// the service actually runs in production.
describe(`GET /sale/status under load (stress, no write contention, CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
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
      THROTTLE_LIMIT: String(CONCURRENT_USERS * 2),
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
        productName: 'Sale Status Stress Widget',
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

  // Splits `amount` across CLIENT_SHARDS parallel client processes so the
  // load generator's own single-process connection-opening pace doesn't
  // become the bottleneck being measured.
  async function fireConcurrentStatusFetches(amount: number): Promise<{
    statuses: number[];
    runResults: autocannon.Result[];
  }> {
    const baseShardAmount = Math.floor(amount / CLIENT_SHARDS);
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
        });
        const { stdout } = await execFileAsync(
          process.execPath,
          [CLIENT_SCRIPT, config],
          { maxBuffer: 64 * 1024 * 1024 },
        );

        return JSON.parse(stdout) as {
          statuses: number[];
          runResult: autocannon.Result;
        };
      }),
    );

    return {
      statuses: shardResults.flatMap((shard) => shard.statuses),
      runResults: shardResults.map((shard) => shard.runResult),
    };
  }

  it(`sustains ${CONCURRENT_USERS} concurrent GET /sale/status requests`, async () => {
    await createActiveSale();

    const { statuses, runResults } =
      await fireConcurrentStatusFetches(CONCURRENT_USERS);

    expect(statuses).toHaveLength(CONCURRENT_USERS);
    expect(statuses.every((status) => status === 200)).toBe(true);

    runResults.forEach((runResult) =>
      console.log(autocannon.printResult(runResult)),
    );
  });
});
