import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderOutboxService } from '../../src/order/outbox/order-outbox.service.ts';
import {
  ORDER_OUTBOX_DEFAULT_KEY,
  orderOutboxDeadLetterKey,
} from '../../src/order/outbox/order-outbox.ts';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service.ts';
import { stockKey } from '../../src/reservation/reservation-keys.ts';
import { ReservationService } from '../../src/reservation/reservation.service.ts';
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
  waitUntil,
} from './fault-test-support.ts';

vi.hoisted(() => {
  process.env.PERSIST_ORDER_ATTEMPTS = '3';
});

describe('persist-order dead-letter path (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(POSTGRES_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('dead-letters an entry that exhausts its attempts, alerts, and leaves it for manual intervention rather than replaying it', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const reservationService = ctx.app.get(ReservationService);
    const outbox = ctx.app.get(OrderOutboxService);
    const reconciliationService = ctx.app.get(ReconciliationService);

    try {
      try {
        await stopContainer(ctx.containerId);

        // The Reservation still succeeds in Redis
        await expect(
          reservationService.reserve(saleId, 'user-1'),
        ).resolves.toBe('success');
        await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');

        // Attempts 1..3 fail against dead Postgres (backoff 1s, 2s) and the
        // entry is dead-lettered with an alert that names the sale and user
        await waitUntil(
          async () =>
            ctx.logger.hasLogged(
              `Order for sale ${saleId}, user user-1 DEAD-LETTERED after 3 attempts`,
            ),
          { timeoutMs: 20_000, description: 'dead-letter alert log line' },
        );
        await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([
          'user-1',
        ]);
        await expect(ctx.redis.xlen(ORDER_OUTBOX_DEFAULT_KEY)).resolves.toBe(0);
      } finally {
        await startContainer(ctx.containerId);
        await waitForHealthy(ctx.containerId, 30_000);
      }

      // Reconciliation notices the dead-lettered entry but leaves it alone:
      // the dead-letter stream is the final resort and a human decides what
      // to do with it
      await reconciliationService.reconcile(saleId);
      expect(
        ctx.logger.hasLogged(
          `1 dead-lettered Order(s) for sale ${saleId} left in the dead-letter stream`,
        ),
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([
        'user-1',
      ]);
      await expect(
        ctx.prisma.order.findUnique({
          where: { saleId_userId: { saleId, userId: 'user-1' } },
        }),
      ).resolves.toBeNull();

      // A human replays it once the cause is fixed and the Order lands
      await expect(outbox.replayDeadLettered(saleId, 'user-1')).resolves.toBe(
        true,
      );
      await waitForOrder(ctx.prisma, saleId, 'user-1', 30_000);

      // Gone from the dead-letter stream, and stock was never touched
      await expect(outbox.listDeadLettered(saleId)).resolves.toEqual([]);
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');
    } finally {
      await ctx.redis.del(orderOutboxDeadLetterKey(ORDER_OUTBOX_DEFAULT_KEY));
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 90_000);
});
