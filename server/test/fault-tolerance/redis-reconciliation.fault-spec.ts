import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
import {
  flushRedis,
  startContainer,
  stopContainer,
  waitForHealthy,
} from './docker-control.ts';
import {
  bootApp,
  cleanupFaultTestSale,
  createSale,
  dumpAppLogsOnFailure,
  FaultTestContext,
  REDIS_PORT,
  setupFaultTest,
  teardownFaultTest,
  waitForOrder,
  waitForValue,
} from './fault-test-support.ts';

describe('Redis data loss reconciliation (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(REDIS_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('rebuilds the stock counter and reserved-user set from durable Orders, with no double-selling', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });

    try {
      // Two purchases land as durable Orders
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-2', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));

      await waitForOrder(ctx.prisma, saleId, 'user-1', 10_000);
      await waitForOrder(ctx.prisma, saleId, 'user-2', 10_000);

      // Wipe Redis completely
      await flushRedis(ctx.containerId);
      await stopContainer(ctx.containerId);
      await startContainer(ctx.containerId);
      await waitForHealthy(ctx.containerId, 30_000);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBeNull();

      // Restart the app against the wiped Redis
      await ctx.app.close();
      ctx.app = await waitForValue(
        async () => {
          const app = await bootApp(ctx.logger);
          const stock = await ctx.redis.get(stockKey(saleId));
          if (stock !== null) return app;
          await app.close();
          return null;
        },
        {
          timeoutMs: 15_000,
          description: 'startup reconciliation to succeed after Redis restart',
        },
      );

      // Stock and reserved users were rebuilt from the Orders
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('3');
      await expect(
        ctx.redis.smembers(reservedUsersKey(saleId)),
      ).resolves.toEqual(expect.arrayContaining(['user-1', 'user-2']));

      // A previous buyer is still recognised
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('already_purchased'));

      // Sell the remaining three units, then confirm the sale is sold out
      for (const userId of ['user-3', 'user-4', 'user-5']) {
        await request(ctx.app.getHttpServer())
          .post('/purchase')
          .send({ userId, saleId })
          .expect(201)
          .then((res) => expect(res.body.result).toBe('success'));
        await waitForOrder(ctx.prisma, saleId, userId, 10_000);
      }
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-6', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('sold_out'));

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('0');
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
