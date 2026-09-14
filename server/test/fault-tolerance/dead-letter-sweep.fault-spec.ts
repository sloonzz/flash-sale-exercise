import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DLQ_SWEEP_LEASE_KEY } from '../../src/order/dead-letter-sweeper.ts';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from '../../src/order/persist-order-job.ts';
import { stockKey } from '../../src/reservation/reservation-keys.ts';
import { ReservationService } from '../../src/reservation/reservation.service.ts';
import {
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
  POSTGRES_PORT,
  setupFaultTest,
  teardownFaultTest,
  waitForOrder,
  waitUntil,
} from './fault-test-support.ts';

const SWEEP_MS = 2_000;
vi.hoisted(() => {
  process.env.PERSIST_ORDER_ATTEMPTS = '3';
  process.env.PERSIST_ORDER_DLQ_SWEEP_MS = '2000';
});

describe('dead-letter sweep across replicas (fault tolerance)', () => {
  let ctx: FaultTestContext;
  let replica: INestApplication;
  let queue: Queue<PersistOrderJobData>;

  beforeAll(async () => {
    ctx = await setupFaultTest(POSTGRES_PORT);
    // A second "replica" sharing the same Redis, Postgres and log buffer
    replica = await bootApp(ctx.logger);
    queue = ctx.app.get(getQueueToken(PERSIST_ORDER_QUEUE));
  });

  afterAll(async () => {
    await replica.close();
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('replays a dead-lettered job automatically once Postgres is back, from exactly one replica', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const jobId = `${saleId}|user-1`;
    const reservationService = ctx.app.get(ReservationService);
    const sweepRetries = () =>
      ctx.logger.count('Sweep retried 1 dead-lettered');

    try {
      try {
        await stopContainer(ctx.containerId);

        await expect(
          reservationService.reserve(saleId, 'user-1'),
        ).resolves.toBe('success');

        await waitUntil(
          async () => ctx.logger.hasLogged(`job ${jobId} DEAD-LETTERED`),
          { timeoutMs: 20_000, description: 'dead-letter alert log line' },
        );

        // While Postgres is still down, sweeps notice the job but hold off
        await waitUntil(
          async () => ctx.logger.hasLogged('Postgres still unreachable'),
          { timeoutMs: SWEEP_MS * 3, description: 'sweep deferral log line' },
        );
        await expect(
          queue.getJob(jobId).then((job) => job?.getState()),
        ).resolves.toBe('failed');
        expect(sweepRetries()).toBe(0);
      } finally {
        await startContainer(ctx.containerId);
        await waitForHealthy(ctx.containerId, 30_000);
      }

      // No manual reconcile: the next sweep after Postgres is healthy replays it
      await waitForOrder(ctx.prisma, saleId, 'user-1', SWEEP_MS * 5 + 30_000);
      await expect(queue.getJob(jobId)).resolves.toBeUndefined();
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('4');

      // Both replicas were ticking, but the lease let only one do the retry
      expect(sweepRetries()).toBe(1);
    } finally {
      await queue.remove(jobId).catch(() => {});
      await ctx.redis.del(DLQ_SWEEP_LEASE_KEY);
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 120_000);
});
