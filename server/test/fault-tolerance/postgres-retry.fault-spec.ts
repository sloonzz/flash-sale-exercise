import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationService } from '../../src/reservation/reservation.service.ts';
import { stockKey } from '../../src/reservation/reservation-keys.ts';
import {
  startContainer,
  stopContainer,
  waitForHealthy,
} from './docker-control.ts';
import {
  cleanupFaultTestSale,
  createSale,
  FaultTestContext,
  POSTGRES_PORT,
  setupFaultTest,
  teardownFaultTest,
  waitForOrder,
} from './fault-test-support.ts';

describe('Postgres-write retry (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(POSTGRES_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  it('retries the BullMQ consumer until the Order lands, without the Postgres outage ever affecting the Reservation', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const reservationService = ctx.app.get(ReservationService);

    try {
      try {
        await stopContainer(ctx.containerId);

        // The purchase HTTP endpoint resolves the current sale from
        // Postgres before ever touching a Reservation, so it can't be
        // used to exercise "Postgres down mid-consumer" — that endpoint
        // would just fail at the sale lookup, before the point this test
        // cares about. Call the Reservation decision directly instead: it
        // only touches Redis (the atomic Lua script) and enqueues the
        // persist job (also Redis, via BullMQ) — neither needs Postgres.
        const result = await reservationService.reserve(saleId, 'user-1');
        expect(result).toBe('success');
        await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');

        // Keep Postgres down past the consumer's fixed 5s backoff so at
        // least one failed attempt + retry actually happens here, rather
        // than the job merely succeeding on a lucky first try later.
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      } finally {
        await startContainer(ctx.containerId);
        await waitForHealthy(ctx.containerId, 30_000);
      }

      await waitForOrder(ctx.prisma, saleId, 'user-1', 30_000);
      const order = await ctx.prisma.order.findUniqueOrThrow({
        where: { saleId_userId: { saleId, userId: 'user-1' } },
      });
      expect(order.userId).toBe('user-1');

      // The Reservation was never rolled back or re-decided by the
      // consumer's retries — stock still reflects the single decrement
      // made before the outage, now that the Order has durably landed.
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
