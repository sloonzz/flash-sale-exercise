import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service.ts';
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
  cleanupFaultTestSale,
  createSale,
  dumpAppLogsOnFailure,
  FaultTestContext,
  REDIS_PORT,
  setupFaultTest,
  teardownFaultTest,
  waitForOrder,
  waitUntil,
} from './fault-test-support.ts';

describe('Redis-restart reconciliation (fault tolerance)', () => {
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

      await flushRedis(ctx.containerId);
      await stopContainer(ctx.containerId);
      await startContainer(ctx.containerId);
      await waitForHealthy(ctx.containerId, 30_000);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBeNull();

      const reconciliationService = ctx.app.get(ReconciliationService);
      await waitUntil(
        async () => {
          try {
            await reconciliationService.reconcile(saleId);
            return true;
          } catch {
            return false;
          }
        },
        {
          timeoutMs: 15_000,
          description: 'reconciliation to succeed after Redis restart',
        },
      );

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('3');
      await expect(
        ctx.redis.smembers(reservedUsersKey(saleId)),
      ).resolves.toEqual(expect.arrayContaining(['user-1', 'user-2']));

      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('already_purchased'));

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
