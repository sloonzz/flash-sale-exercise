import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderQueueProducer } from '../../src/order/order-queue.producer.ts';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from '../../src/order/persist-order-job.ts';
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
  let queue: Queue<PersistOrderJobData>;

  beforeAll(async () => {
    ctx = await setupFaultTest(POSTGRES_PORT);
    queue = ctx.app.get(getQueueToken(PERSIST_ORDER_QUEUE));
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('dead-letters a job that exhausts its attempts, alerts, and replays it via reconciliation once Postgres is back', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const jobId = `${saleId}|user-1`;
    const reservationService = ctx.app.get(ReservationService);
    const producer = ctx.app.get(OrderQueueProducer);
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
        // job is dead-lettered with an alert that names the sale and user
        await waitUntil(
          async () => ctx.logger.hasLogged(`job ${jobId} DEAD-LETTERED`),
          { timeoutMs: 20_000, description: 'dead-letter alert log line' },
        );
        expect(
          ctx.logger.hasLogged(
            `user user-1 holds a Reservation on sale ${saleId}`,
          ),
        ).toBe(true);
        await expect(
          queue.getJob(jobId).then((job) => job?.getState()),
        ).resolves.toBe('failed');
      } finally {
        await startContainer(ctx.containerId);
        await waitForHealthy(ctx.containerId, 30_000);
      }

      // Merely re-enqueueing is not enough: BullMQ ignores an add whose job id
      // already exists, even one sitting in `failed`
      await producer.enqueuePersistOrder(saleId, 'user-1', new Date());
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(
        queue.getJob(jobId).then((job) => job?.getState()),
      ).resolves.toBe('failed');
      await expect(
        ctx.prisma.order.findUnique({
          where: { saleId_userId: { saleId, userId: 'user-1' } },
        }),
      ).resolves.toBeNull();

      // Reconciliation retries the dead-lettered job and the Order lands
      await reconciliationService.reconcile(saleId);
      expect(
        ctx.logger.hasLogged(
          `Retried 1 dead-lettered persist-order job(s) for sale ${saleId}`,
        ),
      ).toBe(true);
      await waitForOrder(ctx.prisma, saleId, 'user-1', 30_000);

      // The job is gone from `failed` (removeOnComplete) and stock was never touched
      await expect(queue.getJob(jobId)).resolves.toBeUndefined();
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');
    } finally {
      await queue.remove(jobId).catch(() => {});
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 90_000);
});
