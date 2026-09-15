import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORDER_OUTBOX_DEFAULT_KEY,
  ORDER_OUTBOX_GROUP,
} from '../../src/order/order-outbox.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
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

describe('Drainer restart with an outbox backlog (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(POSTGRES_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('drains outbox entries left behind by a previous process exactly once, and startup reconciliation does not clobber the live stock they have not yet reached', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 5 });
    const userIds = ['user-1', 'user-2', 'user-3'];

    try {
      try {
        // Take Postgres down before any purchases
        await stopContainer(ctx.containerId);

        // Reserve three units while Postgres is down so the outbox backs up
        for (const userId of userIds) {
          await request(ctx.app.getHttpServer())
            .post('/purchase')
            .send({ userId, saleId })
            .expect(201)
            .then((res) => expect(res.body.result).toBe('success'));
        }
        await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');

        // Wait until every entry has been read and failed once: it sits in
        // the group's pending list while the drainer is in backoff
        await waitUntil(
          async () => {
            const [pending] = (await ctx.redis.xpending(
              ORDER_OUTBOX_DEFAULT_KEY,
              ORDER_OUTBOX_GROUP,
            )) as [number];
            return (
              pending === userIds.length &&
              userIds.every((userId) =>
                ctx.logger.hasLogged(
                  `Failed to persist Order for sale ${saleId}, user ${userId}`,
                ),
              )
            );
          },
          {
            timeoutMs: 15_000,
            description: `all ${userIds.length} outbox entries for sale ${saleId} to fail once and enter backoff`,
          },
        );

        // Restart the app while Postgres is still down
        await ctx.app.close();
        ctx.logger.drain();
        ctx.app = await bootApp(ctx.logger);
        expect(
          ctx.logger.hasLogged('Failed to reconcile sales on startup'),
        ).toBe(true);
      } finally {
        // Bring Postgres back
        await startContainer(ctx.containerId);
        await waitForHealthy(ctx.containerId, 30_000);
      }

      // The new process drains the inherited entries
      for (const userId of userIds) {
        await waitForOrder(ctx.prisma, saleId, userId, 30_000);
      }

      // Exactly one Order each, and reconciliation did not clobber live stock
      await expect(ctx.prisma.order.count({ where: { saleId } })).resolves.toBe(
        userIds.length,
      );
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(
        ctx.redis.smembers(reservedUsersKey(saleId)),
      ).resolves.toEqual(expect.arrayContaining(userIds));

      // Sell the remaining two units, then confirm the sale is sold out
      for (const userId of ['user-4', 'user-5']) {
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
  }, 90_000);
});
