import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { reservedUsersKey, stockKey } from './reservation-keys.ts';
import { RESERVE_SCRIPT } from './reserve-script.ts';
import { SEED_RESERVED_USERS_SCRIPT } from './seed-reserved-users-script.ts';
import { ReservationService } from './reservation.service.ts';

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: {
    eval: vi.fn(),
    set: vi.fn(),
    on: vi.fn(),
    quit: vi.fn(),
  },
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(function RedisMock() {
    return mockRedis;
  }),
}));

describe('ReservationService', () => {
  const orderQueueProducer = {
    enqueuePersistOrder: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrderQueueProducer;
  const service = new ReservationService(orderQueueProducer);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the reservation script against the sale-specific stock and reserved-users keys', async () => {
    mockRedis.eval.mockResolvedValue('success');
    const saleId = randomUUID();

    await service.reserve(saleId, 'user-1');

    expect(mockRedis.eval).toHaveBeenCalledWith(
      RESERVE_SCRIPT,
      2,
      stockKey(saleId),
      reservedUsersKey(saleId),
      'user-1',
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

  it('enqueues a persist-order job only when the reservation succeeds', async () => {
    mockRedis.eval.mockResolvedValue('success');
    const saleId = randomUUID();

    await service.reserve(saleId, 'user-1');

    expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
      saleId,
      'user-1',
      expect.any(Date),
    );
  });

  it('does not enqueue a persist-order job when the reservation is rejected', async () => {
    mockRedis.eval.mockResolvedValue('sold_out');

    await service.reserve(randomUUID(), 'user-1');

    expect(orderQueueProducer.enqueuePersistOrder).not.toHaveBeenCalled();
  });

  it('does not let a failed enqueue fail an already-successful reservation', async () => {
    mockRedis.eval.mockResolvedValue('success');
    vi.mocked(orderQueueProducer.enqueuePersistOrder).mockRejectedValueOnce(
      new Error('queue unavailable'),
    );

    await expect(service.reserve(randomUUID(), 'user-1')).resolves.toBe(
      'success',
    );
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

  it('closes its Redis connection on module destroy', async () => {
    await service.onModuleDestroy();

    expect(mockRedis.quit).toHaveBeenCalled();
  });
});
