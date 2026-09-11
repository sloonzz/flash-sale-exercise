import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis, RedisOptions } from 'ioredis';
import request from 'supertest';
import { AppModule } from '../../src/app.module.ts';
import { DATABASE_URL, REDIS_URL } from '../../src/config/env.ts';
import { PrismaService } from '../../src/prisma/prisma.service.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
import { findContainerByPublishedPort } from './docker-control.ts';

export const ADMIN_KEY = 'test-admin-key';

export const POSTGRES_PORT = Number(new URL(DATABASE_URL).port || 5432);
export const REDIS_PORT = Number(new URL(REDIS_URL).port || 6379);

export interface FaultTestContext {
  app: INestApplication;
  prisma: PrismaService;
  containerId: string;
  redis: Redis;
}

// Bundles the app boot, the docker container this scenario will fault-inject
// against, and a standalone Redis client for asserting on Reservation state
// straight from the source of truth (rather than through the app's own,
// possibly-disconnected client).
export async function setupFaultTest(
  containerPort: number,
  redisOptions?: RedisOptions,
): Promise<FaultTestContext> {
  process.env.ADMIN_KEY = ADMIN_KEY;

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  await app.init();
  // Must precede any request: without an explicit listen, supertest binds
  // its ephemeral port lazily on the first request, which races a later
  // concurrent request and intermittently drops it.
  await app.listen(0);

  const containerId = await findContainerByPublishedPort(containerPort);

  return {
    app,
    prisma: app.get(PrismaService),
    containerId,
    redis: new Redis(REDIS_URL, redisOptions ?? {}),
  };
}

export async function teardownFaultTest(ctx: FaultTestContext): Promise<void> {
  await ctx.app.close();
  await ctx.redis.quit();
}

export async function cleanupFaultTestSale(
  ctx: FaultTestContext,
  saleId: string,
): Promise<void> {
  // Order rows must go first: an Order still referencing this Sale would
  // violate the foreign key once the Sale row is deleted.
  await ctx.prisma.order.deleteMany({ where: { saleId } });
  await ctx.prisma.sale.deleteMany({ where: { id: saleId } });
  await ctx.redis.del(stockKey(saleId), reservedUsersKey(saleId));
}

export async function createSale(
  app: INestApplication,
  overrides: { productName?: string; totalStock?: number } = {},
): Promise<string> {
  const now = Date.now();
  const response = await request(app.getHttpServer())
    .post('/admin/sales')
    .set('x-admin-key', ADMIN_KEY)
    .send({
      productName: overrides.productName ?? 'Fault Tolerance Widget',
      totalStock: overrides.totalStock ?? 10,
      startTime: new Date(now - 60_000).toISOString(),
      endTime: new Date(now + 600_000).toISOString(),
    })
    .expect(201);

  return response.body.id;
}

export async function waitUntil(
  check: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs?: number; description: string },
): Promise<void> {
  const { timeoutMs, intervalMs = 250, description } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

export async function waitForOrder(
  prisma: PrismaService,
  saleId: string,
  userId: string,
  timeoutMs: number,
): Promise<void> {
  await waitUntil(
    async () => {
      const order = await prisma.order.findUnique({
        where: { saleId_userId: { saleId, userId } },
      });
      return order !== null;
    },
    { timeoutMs, description: `order for sale ${saleId} user ${userId}` },
  );
}
