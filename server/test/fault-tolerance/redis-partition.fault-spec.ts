import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_COMMAND_TIMEOUT_MS } from '../../src/config/env.ts';
import {
  reservedUsersKey,
  stockKey,
} from '../../src/reservation/reservation-keys.ts';
import {
  connectNetwork,
  disconnectNetwork,
  getContainerNetwork,
} from './docker-control.ts';
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

describe('Redis network-partition (fault tolerance)', () => {
  let ctx: FaultTestContext;
  let redisNetwork: string;

  beforeAll(async () => {
    ctx = await setupFaultTest(REDIS_PORT, {
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS + 1_000,
    });
    redisNetwork = await getContainerNetwork(ctx.containerId);
  });

  afterAll(async () => {
    await teardownFaultTest(ctx);
  });

  dumpAppLogsOnFailure(() => ctx);

  it('fails purchases gracefully during a Redis outage and resumes with an accurate stock count once reconnected', async () => {
    const saleId = await createSale(ctx.app, { totalStock: 3 });

    try {
      // One healthy purchase before the outage
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-1', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));
      await waitForOrder(ctx.prisma, saleId, 'user-1', 10_000);

      try {
        // Cut Redis off the network
        await disconnectNetwork(redisNetwork, ctx.containerId);

        // Status and purchase both fail with a 5xx instead of hanging
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
        // Reconnect Redis
        await connectNetwork(redisNetwork, ctx.containerId);
      }

      // Wait for the app's Redis client to come back
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

      // The failed purchase left no partial state behind
      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('2');
      await expect(
        ctx.redis.sismember(reservedUsersKey(saleId), 'user-2'),
      ).resolves.toBe(0);
      await expect(
        ctx.prisma.order.count({ where: { saleId, userId: 'user-2' } }),
      ).resolves.toBe(0);

      // Retrying the purchase now succeeds as a first purchase
      await request(ctx.app.getHttpServer())
        .post('/purchase')
        .send({ userId: 'user-2', saleId })
        .expect(201)
        .then((res) => expect(res.body.result).toBe('success'));
      await waitForOrder(ctx.prisma, saleId, 'user-2', 10_000);

      await expect(ctx.redis.get(stockKey(saleId))).resolves.toBe('1');
      await expect(
        ctx.prisma.order.count({ where: { saleId, userId: 'user-2' } }),
      ).resolves.toBe(1);
    } finally {
      await cleanupFaultTestSale(ctx, saleId);
    }
  }, 60_000);
});
