import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_OUTBOX_CLAIM_IDLE_MS } from '../../src/config/env.ts';
import {
  ORDER_OUTBOX_BLOCK_MS,
  OrderOutboxDrainer,
} from '../../src/order/order-outbox.drainer.ts';
import {
  ORDER_OUTBOX_DEFAULT_KEY,
  ORDER_OUTBOX_GROUP,
} from '../../src/order/order-outbox.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
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

// Reclaim entries held by a dead drainer quickly so the test doesn't wait 30s
vi.hoisted(() => {
  process.env.ORDER_OUTBOX_CLAIM_IDLE_MS = '1000';
});

describe('Order outbox: write failure and drainer crash (fault tolerance)', () => {
  let ctx: FaultTestContext;

  beforeAll(async () => {
    ctx = await setupFaultTest(REDIS_PORT);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  async function outboxPending(): Promise<number> {
    const [count] = (await ctx.redis.xpending(
      ORDER_OUTBOX_DEFAULT_KEY,
      ORDER_OUTBOX_GROUP,
    )) as [number];
    return count;
  }

  it('keeps retrying a Reservation whose Order write fails until it lands — no app restart', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 3 });

    try {
      // Make every Order write blow up until told otherwise
      const writeSpy = vi
        .spyOn(ctx.prisma.order, 'createMany')
        .mockRejectedValue(new Error('simulated write failure'));

      // The purchase still succeeds from the buyer's point of view
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));

      // The drainer keeps picking the outbox entry back up and failing
      await waitUntil(
        async () =>
          writeSpy.mock.settledResults.filter((r) => r.type === 'rejected')
            .length >= 3,
        { timeoutMs: 10_000, description: 'three failed write attempts' },
      );
      expect(
        ctx.logger.hasLogged(
          `Failed to persist Order for sale ${saleId}, user user-1`,
        ),
      ).toBe(true);

      // The Reservation stands, and the intent to persist it was never lost:
      // the outbox entry is still there, unacknowledged
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
      await expect(outboxPending()).resolves.toBe(1);

      // Let the write work again: the next pass succeeds and the Order lands
      writeSpy.mockRestore();
      await waitForOrder(ctx.prisma, saleId, 'user-1', 10_000);

      // Exactly one Order, stock unchanged, outbox fully drained
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(ctx.prisma.order.count({ where: { saleId } })).resolves.toBe(
        1,
      );
      await expect(ctx.redis.xlen(ORDER_OUTBOX_DEFAULT_KEY)).resolves.toBe(0);
      await expect(outboxPending()).resolves.toBe(0);
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);

  it('reclaims an outbox entry from a drainer that died between reading it and enqueueing it, once it has been idle for ORDER_OUTBOX_CLAIM_IDLE_MS', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 3 });

    try {
      // Stop the live drainer reading, so the entry is still there for the
      // "crashed" worker to take. Its current blocking read is already on
      // the wire, so let that one expire before writing the entry.
      const drainer = ctx.app.get(OrderOutboxDrainer);
      const readSpy = vi
        .spyOn(drainer['client'], 'xreadgroup')
        .mockResolvedValue(null);
      await new Promise((resolve) =>
        setTimeout(resolve, ORDER_OUTBOX_BLOCK_MS + 500),
      );

      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));

      // Another worker reads the entry and then dies before writing it
      await ctx.redis.xreadgroup(
        'GROUP',
        ORDER_OUTBOX_GROUP,
        'crashed-worker',
        'STREAMS',
        ORDER_OUTBOX_DEFAULT_KEY,
        '>',
      );
      await expect(outboxPending()).resolves.toBe(1);
      readSpy.mockRestore();

      // The live drainer reclaims it on its timer and the Order lands — the
      // dead worker is never restarted
      await waitForOrder(
        ctx.prisma,
        saleId,
        'user-1',
        ORDER_OUTBOX_CLAIM_IDLE_MS + 10_000,
      );
      expect(ctx.logger.hasLogged('Reclaimed 1 order-outbox entry')).toBe(true);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(ctx.prisma.order.count({ where: { saleId } })).resolves.toBe(
        1,
      );
      await expect(ctx.redis.xlen(ORDER_OUTBOX_DEFAULT_KEY)).resolves.toBe(0);
      await expect(outboxPending()).resolves.toBe(0);
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
