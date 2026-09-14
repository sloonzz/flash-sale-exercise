import { inspect } from 'node:util';
import { INestApplication, LoggerService } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Redis, RedisOptions } from 'ioredis';
import request from 'supertest';
import { afterEach } from 'vitest';
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

// Fault tests error by default so we buffer the logs so they don't bury the test results
class BufferedLogger implements LoggerService {
  private lines: string[] = [];
  error = (message: unknown, ...params: unknown[]) =>
    this.push('ERROR', message, params);
  warn = (message: unknown, ...params: unknown[]) =>
    this.push('WARN', message, params);
  fatal = (message: unknown, ...params: unknown[]) =>
    this.push('FATAL', message, params);
  log = () => {};
  debug = () => {};
  verbose = () => {};
  drain(): string[] {
    const lines = this.lines;
    this.lines = [];
    return lines;
  }
  hasLogged(substring: string): boolean {
    return this.lines.some((line) => line.includes(substring));
  }
  private push(level: string, message: unknown, params: unknown[]): void {
    const context =
      typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const parts = [message, ...params].map((part) =>
      typeof part === 'string' ? part : inspect(part),
    );
    this.lines.push(
      `${level.padEnd(5)} ${context ? `[${context}] ` : ''}${parts.join('\n')}`,
    );
  }
}

export interface FaultTestContext {
  app: INestApplication;
  prisma: PrismaService;
  containerId: string;
  redis: Redis;
  logger: BufferedLogger;
}

export async function setupFaultTest(
  containerPort: number,
  redisOptions?: RedisOptions,
): Promise<FaultTestContext> {
  process.env.ADMIN_KEY = ADMIN_KEY;
  const logger = new BufferedLogger();
  const app = await bootApp(logger);

  const containerId = await findContainerByPublishedPort(containerPort);

  return {
    app,
    prisma: app.get(PrismaService),
    containerId,
    redis: new Redis(REDIS_URL, redisOptions ?? {}),
    logger,
  };
}

export async function bootApp(
  logger: BufferedLogger,
): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .setLogger(logger)
    .compile();

  const app = moduleFixture.createNestApplication({ logger });
  await app.init();
  await app.listen(0);
  return app;
}

export function dumpAppLogsOnFailure(getCtx: () => FaultTestContext): void {
  afterEach(({ task }) => {
    const lines = getCtx().logger.drain();
    if (task.result?.state !== 'fail' || lines.length === 0) return;
    process.stderr.write(
      `\n--- app logs during failed test "${task.name}" ---\n` +
        `${lines.join('\n')}\n` +
        `--- end app logs ---\n`,
    );
  });
}

export async function teardownFaultTest(ctx: FaultTestContext): Promise<void> {
  await ctx.app.close();
  await ctx.redis.quit();
}

export async function cleanupFaultTestSale(
  ctx: FaultTestContext,
  saleId: string,
): Promise<void> {
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

export async function waitForValue<T>(
  check: () => Promise<T | null>,
  options: { timeoutMs: number; intervalMs?: number; description: string },
): Promise<T> {
  const { timeoutMs, intervalMs = 250, description } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
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
