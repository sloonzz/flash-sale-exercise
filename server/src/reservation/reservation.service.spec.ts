import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { RESERVE_SCRIPT } from './reserve-script.ts';
import { SEED_RESERVED_USERS_SCRIPT } from './seed-reserved-users-script.ts';
import { ReservationService } from './reservation.service.ts';

describe('ReservationService', () => {
  const mockRedis = {
    eval: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    sismember: vi.fn(),
    smembers: vi.fn(),
  };
  const outboxKey = 'order-outbox-test';
  const service = new ReservationService(
    mockRedis as unknown as Redis,
    outboxKey,
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the reservation script against the sale-specific stock and reserved-users keys and the order outbox', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-14T12:00:00.000Z');
    vi.setSystemTime(now);
    mockRedis.eval.mockResolvedValue('success');
    const saleId = randomUUID();

    await service.reserve(saleId, 'user-1');

    expect(mockRedis.eval).toHaveBeenCalledWith(
      RESERVE_SCRIPT,
      3,
      stockKey(saleId),
      reservedUsersKey(saleId),
      outboxKey,
      'user-1',
      saleId,
      now.toISOString(),
    );
  });

  it.each(['success', 'already_purchased', 'sold_out'] as const)(
    'resolves with whatever the reservation script returns (%s)',
    async (result) => {
      mockRedis.eval.mockResolvedValue(result);

      await expect(service.reserve(randomUUID(), 'user-1')).resolves.toBe(
        result,
      );
    },
  );

  it('makes exactly one Redis call per reservation: the outbox write is inside the script, not a follow-up', async () => {
    mockRedis.eval.mockResolvedValue('success');

    await service.reserve(randomUUID(), 'user-1');

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('seeds stock with SET NX so an existing counter is never overwritten', async () => {
    const saleId = randomUUID();

    await service.initializeStock(saleId, 10);

    expect(mockRedis.set).toHaveBeenCalledWith(stockKey(saleId), 10, 'NX');
  });

  it('seeds reserved users via the seed script', async () => {
    const saleId = randomUUID();

    await service.seedReservedUsers(saleId, ['user-1', 'user-2']);

    expect(mockRedis.eval).toHaveBeenCalledWith(
      SEED_RESERVED_USERS_SCRIPT,
      1,
      reservedUsersKey(saleId),
      'user-1',
      'user-2',
    );
  });

  it('reads the stock counter as a number', async () => {
    const saleId = randomUUID();
    mockRedis.get.mockResolvedValue('7');

    await expect(service.getStock(saleId)).resolves.toBe(7);
    expect(mockRedis.get).toHaveBeenCalledWith(stockKey(saleId));
  });

  it('reports a missing stock counter as null', async () => {
    mockRedis.get.mockResolvedValue(null);

    await expect(service.getStock(randomUUID())).resolves.toBeNull();
  });

  it('reports whether a user is in the reserved-users set', async () => {
    const saleId = randomUUID();
    mockRedis.sismember.mockResolvedValue(1);

    await expect(service.isReserved(saleId, 'user-1')).resolves.toBe(true);
    expect(mockRedis.sismember).toHaveBeenCalledWith(
      reservedUsersKey(saleId),
      'user-1',
    );
  });

  it('reports a user not in the reserved-users set as false', async () => {
    mockRedis.sismember.mockResolvedValue(0);

    await expect(service.isReserved(randomUUID(), 'user-1')).resolves.toBe(
      false,
    );
  });

  it('lists the members of the reserved-users set', async () => {
    const saleId = randomUUID();
    mockRedis.smembers.mockResolvedValue(['user-1', 'user-2']);

    await expect(service.getReservedUsers(saleId)).resolves.toEqual([
      'user-1',
      'user-2',
    ]);
    expect(mockRedis.smembers).toHaveBeenCalledWith(reservedUsersKey(saleId));
  });
});
