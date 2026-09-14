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
  dumpAppLogsOnFailure,
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

  dumpAppLogsOnFailure(() => ctx);

  it('retries the BullMQ consumer until the Order lands, without the Postgres outage ever affecting the Reservation', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const reservationService = ctx.app.get(ReservationService);

    try {
      try {
        await stopContainer(ctx.containerId);

        const result = await reservationService.reserve(saleId, 'user-1');
        expect(result).toBe('success');
        await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');

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

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
