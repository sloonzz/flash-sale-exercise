import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';
import { REDIS_URL } from '../src/config/env.ts';
import { PrismaService } from '../src/prisma/prisma.service.ts';
import { stockKey } from '../src/reservation/reservation-keys.ts';
import { currentSaleKey } from '../src/sale/sale-cache.ts';

const execFileAsync = promisify(execFile);
const CLIENT_SCRIPT = fileURLToPath(
  new URL('./support/sale-status-autocannon-client.ts', import.meta.url),
);

const ADMIN_KEY = 'test-admin-key';
const CONCURRENT_USERS = Number(process.env.STRESS_USERS ?? 250);

describe('GET /sale/status under load (stress, no write contention)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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

    const address = app.getHttpServer().address();
    const port = typeof address === 'string' ? address : address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    const keys = saleIds.map((saleId) => stockKey(saleId));
    keys.push(currentSaleKey());
    await redis.del(...keys);
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    saleIds.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  async function createActiveSale(): Promise<string> {
    const now = Date.now();
    const response = await request(app.getHttpServer())
      .post('/admin/sales')
      .set('x-admin-key', ADMIN_KEY)
      .send({
        productName: 'Sale Status Stress Widget',
        totalStock: 1000,
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now + 5 * 60_000).toISOString(),
      })
      .expect(201);

    saleIds.push(response.body.id);
    return response.body.id;
  }

  async function fireConcurrentStatusFetches(amount: number): Promise<{
    statuses: number[];
    runResult: autocannon.Result;
  }> {
    const config = JSON.stringify({ url: baseUrl, amount });
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLIENT_SCRIPT, config],
      { maxBuffer: 64 * 1024 * 1024 },
    );

    return JSON.parse(stdout);
  }

  it(`sustains ${CONCURRENT_USERS} concurrent GET /sale/status requests`, async () => {
    await createActiveSale();

    const { statuses, runResult } =
      await fireConcurrentStatusFetches(CONCURRENT_USERS);

    expect(statuses).toHaveLength(CONCURRENT_USERS);
    expect(statuses.every((status) => status === 200)).toBe(true);

    console.log(autocannon.printResult(runResult));
  });
});
