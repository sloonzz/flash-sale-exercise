import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from '../../src/order/persist-order-job.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
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
  waitUntil,
} from './fault-test-support.ts';

describe('BullMQ enqueue failure (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(REDIS_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('re-enqueues a Reservation whose persist-order job never made it onto the queue, so the Order still lands', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 3 });
    const queue = ctx.app.get<Queue<PersistOrderJobData>>(
      getQueueToken(PERSIST_ORDER_QUEUE),
    );

    try {
      // Make the next queue.add() blow up
      const addSpy = vi
        .spyOn(queue, 'add')
        .mockRejectedValueOnce(new Error('simulated enqueue failure'));

      // The purchase still succeeds from the buyer's point of view
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));

      // Wait for the mocked enqueue to actually reject
      await waitUntil(
        async () =>
          addSpy.mock.settledResults.some((r) => r.type === 'rejected'),
        { timeoutMs: 5_000, description: 'simulated enqueue failure' },
      );
      expect(addSpy).toHaveBeenCalledTimes(1);
      addSpy.mockRestore();

      // The Reservation stands even though no Order was queued
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(
        ctx.redis.sismember(reservedUsersKey(saleId), 'user-1'),
      ).resolves.toBe(1);
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('already_purchased'));
      await expect(
        ctx.prisma.order.count({ where: { saleId, userId: 'user-1' } }),
      ).resolves.toBe(0);

      // Restart the app so reconciliation re-enqueues the missing Order
      await ctx.app.close();
      ctx.app = await bootApp(ctx.logger);

      await waitForOrder(ctx.prisma, saleId, 'user-1', 15_000);

      // Exactly one Order and stock unchanged
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(ctx.prisma.order.count({ where: { saleId } })).resolves.toBe(
        1,
      );
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
