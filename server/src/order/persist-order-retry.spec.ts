import { describe, expect, it } from 'vitest';
import {
  PERSIST_ORDER_BACKOFF_BASE_MS,
  PERSIST_ORDER_BACKOFF_JITTER,
  PERSIST_ORDER_BACKOFF_MAX_MS,
  persistOrderBackoffDelay,
} from './persist-order-retry.ts';

const within = (value: number, target: number) => {
  const tolerance = target * PERSIST_ORDER_BACKOFF_JITTER;
  expect(value).toBeGreaterThanOrEqual(target - tolerance);
  expect(value).toBeLessThanOrEqual(target + tolerance);
};

describe('persistOrderBackoffDelay', () => {
  it('doubles from the base delay on each attempt', () => {
    within(persistOrderBackoffDelay(1), PERSIST_ORDER_BACKOFF_BASE_MS);
    within(persistOrderBackoffDelay(2), PERSIST_ORDER_BACKOFF_BASE_MS * 2);
    within(persistOrderBackoffDelay(3), PERSIST_ORDER_BACKOFF_BASE_MS * 4);
    within(persistOrderBackoffDelay(4), PERSIST_ORDER_BACKOFF_BASE_MS * 8);
  });

  it('never exceeds the cap, even after many attempts', () => {
    for (const attempt of [6, 10, 20, 100, 100_000]) {
      within(persistOrderBackoffDelay(attempt), PERSIST_ORDER_BACKOFF_MAX_MS);
    }
  });

  it('treats attempt 0 like the first attempt', () => {
    within(persistOrderBackoffDelay(0), PERSIST_ORDER_BACKOFF_BASE_MS);
  });
});
