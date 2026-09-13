import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import autocannon from 'autocannon';
import type { Queue } from 'bullmq';
import type { PurchaseResult } from 'common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { REDIS_URL } from '../src/config/env.ts';
import { PERSIST_ORDER_QUEUE } from '../src/order/persist-order-job.ts';
import { PrismaService } from '../src/prisma/prisma.service.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../src/reservation/reservation-keys.ts';
import { currentSaleKey } from '../src/sale/sale-cache.ts';

const execFileAsync = promisify(execFile);
const CLIENT_SCRIPT = fileURLToPath(
  new URL('./support/autocannon-client.ts', import.meta.url),
);

const ADMIN_KEY = 'test-admin-key';

const TOTAL_STOCK = Number(process.env.STRESS_STOCK ?? 50);
const CONCURRENT_USERS = Number(process.env.STRESS_USERS ?? 250);

if (TOTAL_STOCK >= CONCURRENT_USERS) {
  throw new Error(
    `STRESS_STOCK (${TOTAL_STOCK}) must be less than STRESS_USERS (${CONCURRENT_USERS}) -- this suite exists to prove the reservation never oversells when demand exceeds stock.`,
  );
}

describe('Purchase under load (stress)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let persistOrderQueue: Queue;
  let baseUrl: string;
  const redis = new Redis(REDIS_URL);
  const saleIds: string[] = [];

  beforeAll(async () => {
    process.env.ADMIN_KEY = ADMIN_KEY;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    prisma = app.get(PrismaService);
    persistOrderQueue = app.get(getQueueToken(PERSIST_ORDER_QUEUE));

    const address = app.getHttpServer().address();
    const port = typeof address === 'string' ? address : address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

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
    await app.close();
    await redis.quit();
  });

  async function createSale(totalStock: number): Promise<string> {
    const now = Date.now();
    const response = await request(app.getHttpServer())
      .post('/admin/sales')
      .set('x-admin-key', ADMIN_KEY)
      .send({
        productName: 'Stress Test Widget',
        totalStock,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now + 5 * 60_000).toISOString(),
      })
      .expect(201);

    saleIds.push(response.body.id);
    return response.body.id;
  }

  // Runs autocannon in a separate OS process from the server under test.
  async function fireConcurrentPurchases(
    amount: number,
    userIds: 'unique' | 'duplicate',
    saleId: string,
  ): Promise<{
    results: Array<PurchaseResultOrNull>;
    runResult: autocannon.Result;
  }> {
    const config = JSON.stringify({ url: baseUrl, amount, saleId, userIds });
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLIENT_SCRIPT, config],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    return JSON.parse(stdout);
  }

  it(`grants exactly ${TOTAL_STOCK} of ${CONCURRENT_USERS} concurrent unique-user purchases, with zero oversell`, async () => {
    const saleId = await createSale(TOTAL_STOCK);

    const { results, runResult } = await fireConcurrentPurchases(
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

    console.log(autocannon.printResult(runResult));
  });

  it(`grants all ${CONCURRENT_USERS} concurrent unique-user purchases when stock far exceeds demand`, async () => {
    const abundantStock = CONCURRENT_USERS * 10;
    const saleId = await createSale(abundantStock);

    const { results, runResult } = await fireConcurrentPurchases(
      CONCURRENT_USERS,
      'unique',
      saleId,
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

    console.log(autocannon.printResult(runResult));
  });

  it(`grants exactly 1 of ${CONCURRENT_USERS} concurrent purchase attempts from the same user`, async () => {
    const saleId = await createSale(CONCURRENT_USERS);

    const { results, runResult } = await fireConcurrentPurchases(
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

    console.log(autocannon.printResult(runResult));
  });
});

type PurchaseResultOrNull = PurchaseResult | null;
