import autocannon from 'autocannon';
import { describe, expect, it } from 'vitest';
import { stockKey } from '../src/reservation/reservation-keys.ts';
import { CLUSTER_WORKERS, LOAD_PROFILES } from './support/config.ts';
import { usePerformanceHarness } from './support/performance-harness.ts';

const UNDERSTOCKED_STOCK = Number(process.env.UNDERSTOCKED_STOCK ?? 50);

// Far more than any run can consume, so the reservation never hits zero
const OVERSTOCKED_STOCK = 10_000_000;

describe(`POST /purchase (CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
  const harness = usePerformanceHarness();

  for (const profile of LOAD_PROFILES) {
    describe(`under ${profile.name} load (${profile.connections} connections for ${profile.durationSeconds}s)`, () => {
      it(`grants exactly ${UNDERSTOCKED_STOCK} unique-user purchases, with zero oversell under ${profile.name.toUpperCase()} LOAD`, async () => {
        const saleId = await harness.createSale(
          'Understocked Widget',
          UNDERSTOCKED_STOCK,
        );

        const runResult = await harness.firePurchases(
          profile,
          'unique',
          saleId,
        );

        expect(runResult.requests.total).toBeGreaterThan(UNDERSTOCKED_STOCK);

        await expect(harness.redis.get(stockKey(saleId))).resolves.toBe('0');
        await harness.expectPersistedOrders(saleId, UNDERSTOCKED_STOCK);
        await expect(harness.countDistinctBuyers(saleId)).resolves.toBe(
          UNDERSTOCKED_STOCK,
        );

        console.log(autocannon.printResult(runResult));
      });

      it(`grants every unique-user purchase exactly once when stock (${OVERSTOCKED_STOCK.toLocaleString()}) far exceeds demand under ${profile.name.toUpperCase()} LOAD`, async () => {
        const saleId = await harness.createSale(
          'Overstocked Widget',
          OVERSTOCKED_STOCK,
        );

        const runResult = await harness.firePurchases(
          profile,
          'unique',
          saleId,
        );

        // Wait for the async BullMQ consumer to catch up with the reservation
        let stockConsumed = -1;
        await expect
          .poll(
            async () => {
              const [stock, orderCount] = await Promise.all([
                harness.redis.get(stockKey(saleId)),
                harness.prisma.order.count({ where: { saleId } }),
              ]);
              stockConsumed = OVERSTOCKED_STOCK - Number(stock);
              return orderCount === stockConsumed;
            },
            { timeout: 60_000, interval: 100 },
          )
          .toBe(true);

        await expect(harness.countDistinctBuyers(saleId)).resolves.toBe(
          stockConsumed,
        );

        console.log(autocannon.printResult(runResult));
      });

      it(`grants exactly 1 purchase when every connection is the same user under ${profile.name.toUpperCase()} LOAD`, async () => {
        const saleId = await harness.createSale(
          'Same-User Widget',
          profile.connections,
        );

        const runResult = await harness.firePurchases(
          profile,
          'duplicate',
          saleId,
        );

        await harness.expectPersistedOrders(saleId, 1);

        console.log(autocannon.printResult(runResult));
      });
    });
  }
});
