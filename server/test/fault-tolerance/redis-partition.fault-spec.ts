import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_COMMAND_TIMEOUT_MS } from '../../src/config/env.ts';
import { stockKey } from '../../src/reservation/reservation-keys.ts';
import {
  connectNetwork,
  disconnectNetwork,
  getContainerNetwork,
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

describe('Redis network-partition (fault tolerance)', () => {
  let ctx: FaultTestContext;
  let redisNetwork: string;

  beforeAll(async () => {
    // Longer than the app's own REDIS_COMMAND_TIMEOUT_MS: this client is
    // only used for assertions and reconnect polling once the partition is
    // over, so it should never itself be the thing timing out first.
    ctx = await setupFaultTest(REDIS_PORT, {
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS + 1_000,
    });
    redisNetwork = await getContainerNetwork(ctx.containerId);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  it('fails purchases gracefully during a Redis outage and resumes with an accurate stock count once reconnected', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 3 });

    try {
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));
      await waitForOrder(ctx.prisma, saleId, 'user-1', 10_000);

      try {
        await disconnectNetwork(redisNetwork, ctx.containerId);

        // A clear error, not a crash or a hang: bounded by the app's own
        // Redis command timeout, not by however long the partition lasts.
        const statusDuringOutage = await request(ctx.app.getHttpServer())
          .get('/sale/status')
          .timeout(5_000);
        expect(statusDuringOutage.status).toBeGreaterThanOrEqual(500);

        const purchaseDuringOutage = await request(ctx.app.getHttpServer())
          .post('/purchase')
          .send({ userId: 'user-2', saleId })
          .timeout(5_000);
        expect(purchaseDuringOutage.status).toBeGreaterThanOrEqual(500);
      } finally {
        await connectNetwork(redisNetwork, ctx.containerId);
      }

      // The app's Redis client reconnects on its own schedule; wait for
      // it rather than assuming reconnection is instant.
      await waitUntil(
        async () => {
          try {
            await ctx.redis.ping();
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 15_000, description: 'Redis client to reconnect' },
      );

      // The failed attempt during the outage must not have consumed the
      // user's one-purchase-per-sale slot or any stock.
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-2', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));
      await waitForOrder(ctx.prisma, saleId, 'user-2', 10_000);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('1');
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
