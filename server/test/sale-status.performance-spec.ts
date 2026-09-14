import autocannon from 'autocannon';
import { describe, expect, it } from 'vitest';
import { currentSaleKey, deserializeSale } from '../src/sale/sale-cache.ts';
import { CLUSTER_WORKERS, LOAD_PROFILES } from './support/config.ts';
import { usePerformanceHarness } from './support/performance-harness.ts';

describe(`GET /sale/status (CLUSTER_WORKERS=${CLUSTER_WORKERS})`, () => {
  const harness = usePerformanceHarness();

  for (const profile of LOAD_PROFILES) {
    describe(`under ${profile.name} load (${profile.connections} connections for ${profile.durationSeconds}s)`, () => {
      it(`answers every request without errors and leaves the cached sale intact under ${profile.name.toUpperCase()} LOAD`, async () => {
        const saleId = await harness.createSale('Sale Status Widget', 1000);

        const runResult = await harness.fireStatusFetches(profile);

        const cached = await harness.redis.get(currentSaleKey());
        expect(cached).not.toBeNull();
        expect(deserializeSale(cached!).id).toBe(saleId);

        console.log(autocannon.printResult(runResult));
      });
    });
  }
});
