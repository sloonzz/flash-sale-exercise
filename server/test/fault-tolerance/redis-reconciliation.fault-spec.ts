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

      // Both Orders must be durably in Postgres before Redis is
      // destroyed — reconciliation only sees what's already landed.
      await waitForOrder(ctx.prisma, saleId, 'user-1', 10_000);
      await waitForOrder(ctx.prisma, saleId, 'user-2', 10_000);

      await flushRedis(ctx.containerId);
      await stopContainer(ctx.containerId);
      await startContainer(ctx.containerId);
      await waitForHealthy(ctx.containerId, 30_000);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBeNull();

      // There is no production admin endpoint or startup hook that
      // re-runs reconciliation for an already-existing sale today — it
      // currently only fires from sale *creation* (see
      // SaleService.createSale). Wiring that trigger is a separate
      // concern from this ticket (building/testing the fault-tolerance
      // behavior), so the most faithful thing this test can do is invoke
      // the reconciliation function itself directly, which is exactly
      // what an admin/startup check would eventually call into.
      const reconciliationService = ctx.app.get(ReconciliationService);
      // The app's own Redis client reconnects on its own schedule after
      // the container comes back; reconcile() is idempotent, so retrying
      // it until it succeeds waits out that reconnect.
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

      // No double-selling: an already-sold user is rejected, not re-sold.
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('already_purchased'));

      // Remaining stock (3) sells through exactly, then sold_out.
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
