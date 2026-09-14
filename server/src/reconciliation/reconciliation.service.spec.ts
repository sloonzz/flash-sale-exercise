import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RECONCILE_SALES_WINDOW_MS } from '../config/env.ts';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { ReconciliationService } from './reconciliation.service.ts';

describe('ReconciliationService', () => {
  const prisma = {
    sale: { findUniqueOrThrow: vi.fn(), findMany: vi.fn() },
    order: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const reservationService = {
    initializeStock: vi.fn().mockResolvedValue(undefined),
    seedReservedUsers: vi.fn().mockResolvedValue(undefined),
    getReservedUsers: vi.fn().mockResolvedValue([]),
  } as unknown as ReservationService;
  const orderQueueProducer = {
    enqueuePersistOrder: vi.fn().mockResolvedValue(undefined),
    retryDeadLettered: vi.fn().mockResolvedValue([]),
  } as unknown as OrderQueueProducer;
  const reconciliationService = new ReconciliationService(
    prisma,
    reservationService,
    orderQueueProducer,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.order.findMany).mockResolvedValue([]);
    vi.mocked(reservationService.getReservedUsers).mockResolvedValue([]);
    vi.mocked(orderQueueProducer.retryDeadLettered).mockResolvedValue([]);
  });

  describe('onApplicationBootstrap', () => {
    it('reconciles every sale, newest first', async () => {
      const newSaleId = randomUUID();
      const oldSaleId = randomUUID();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([
        { id: newSaleId },
        { id: oldSaleId },
      ] as never);
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockImplementation((({
        where,
      }: {
        where: { saleId: string };
      }) =>
        Promise.resolve(
          where.saleId === oldSaleId ? [{ userId: 'user-1' }] : [],
        )) as never);

      await reconciliationService.onApplicationBootstrap();

      expect(prisma.sale.findMany).toHaveBeenCalledWith({
        where: { endTime: { gte: expect.any(Date) } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(reservationService.initializeStock).toHaveBeenNthCalledWith(
        1,
        newSaleId,
        10,
      );
      expect(reservationService.initializeStock).toHaveBeenNthCalledWith(
        2,
        oldSaleId,
        9,
      );
      expect(reservationService.seedReservedUsers).toHaveBeenCalledWith(
        oldSaleId,
        ['user-1'],
      );
    });

    it('re-enqueues orphaned reservations on an older sale, not just the current one', async () => {
      const newSaleId = randomUUID();
      const oldSaleId = randomUUID();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([
        { id: newSaleId },
        { id: oldSaleId },
      ] as never);
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([]);
      vi.mocked(reservationService.getReservedUsers).mockImplementation(
        (saleId) =>
          Promise.resolve(saleId === oldSaleId ? ['user-orphan'] : []),
      );

      await reconciliationService.onApplicationBootstrap();

      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledTimes(1);
      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
        oldSaleId,
        'user-orphan',
        expect.any(Date),
      );
    });

    it('keeps reconciling the remaining sales when one of them fails', async () => {
      const brokenSaleId = randomUUID();
      const healthySaleId = randomUUID();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([
        { id: brokenSaleId },
        { id: healthySaleId },
      ] as never);
      vi.mocked(prisma.sale.findUniqueOrThrow).mockImplementation((({
        where,
      }: {
        where: { id: string };
      }) =>
        where.id === brokenSaleId
          ? Promise.reject(new Error('sale vanished'))
          : Promise.resolve({ totalStock: 10 })) as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([]);

      await expect(
        reconciliationService.onApplicationBootstrap(),
      ).resolves.toBeUndefined();

      expect(reservationService.initializeStock).toHaveBeenCalledTimes(1);
      expect(reservationService.initializeStock).toHaveBeenCalledWith(
        healthySaleId,
        10,
      );
    });

    it('only looks at sales that ended within RECONCILE_SALES_WINDOW_MS', async () => {
      vi.useFakeTimers();
      try {
        const now = new Date('2026-09-14T12:00:00Z');
        vi.setSystemTime(now);
        vi.mocked(prisma.sale.findMany).mockResolvedValue([]);

        await reconciliationService.onApplicationBootstrap();

        expect(prisma.sale.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              endTime: {
                gte: new Date(now.getTime() - RECONCILE_SALES_WINDOW_MS),
              },
            },
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does nothing when no sale exists yet', async () => {
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);

      await reconciliationService.onApplicationBootstrap();

      expect(prisma.sale.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(reservationService.initializeStock).not.toHaveBeenCalled();
      expect(reservationService.seedReservedUsers).not.toHaveBeenCalled();
    });

    it('logs and swallows reconciliation failures so the app still boots', async () => {
      vi.mocked(prisma.sale.findMany).mockRejectedValue(
        new Error('postgres down'),
      );

      await expect(
        reconciliationService.onApplicationBootstrap(),
      ).resolves.toBeUndefined();
    });
  });

  it('seeds stock as totalStock minus the existing order count', async () => {
    const saleId = randomUUID();
    vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
      totalStock: 10,
    } as never);
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-2' },
    ] as never);

    await reconciliationService.reconcile(saleId);

    expect(prisma.sale.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: saleId },
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { saleId },
      select: { userId: true },
    });
    expect(reservationService.initializeStock).toHaveBeenCalledWith(saleId, 8);
  });

  it('seeds the reserved-users set with every existing order’s user id', async () => {
    const saleId = randomUUID();
    vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
      totalStock: 10,
    } as never);
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-2' },
    ] as never);

    await reconciliationService.reconcile(saleId);

    expect(reservationService.seedReservedUsers).toHaveBeenCalledWith(saleId, [
      'user-1',
      'user-2',
    ]);
  });

  it('seeds full stock and no reserved users for a sale with no orders yet', async () => {
    const saleId = randomUUID();
    vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
      totalStock: 10,
    } as never);
    vi.mocked(prisma.order.findMany).mockResolvedValue([]);

    await reconciliationService.reconcile(saleId);

    expect(reservationService.initializeStock).toHaveBeenCalledWith(saleId, 10);
    expect(reservationService.seedReservedUsers).toHaveBeenCalledWith(
      saleId,
      [],
    );
  });

  describe('orphaned reservations', () => {
    it('re-enqueues a persist-order job for each reserved user with no Order', async () => {
      const saleId = randomUUID();
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([
        { userId: 'user-1' },
      ] as never);
      vi.mocked(reservationService.getReservedUsers).mockResolvedValue([
        'user-1',
        'user-2',
        'user-3',
      ]);

      await reconciliationService.reconcile(saleId);

      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledTimes(2);
      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
        saleId,
        'user-2',
        expect.any(Date),
      );
      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
        saleId,
        'user-3',
        expect.any(Date),
      );
    });

    it('enqueues nothing when every reserved user already has an Order', async () => {
      const saleId = randomUUID();
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([
        { userId: 'user-1' },
      ] as never);
      vi.mocked(reservationService.getReservedUsers).mockResolvedValue([
        'user-1',
      ]);

      await reconciliationService.reconcile(saleId);

      expect(orderQueueProducer.enqueuePersistOrder).not.toHaveBeenCalled();
      expect(orderQueueProducer.retryDeadLettered).not.toHaveBeenCalled();
    });

    it('retries dead-lettered jobs instead of re-enqueueing them (add is a no-op on an existing job id)', async () => {
      const saleId = randomUUID();
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([] as never);
      vi.mocked(reservationService.getReservedUsers).mockResolvedValue([
        'user-1',
        'user-2',
      ]);
      vi.mocked(orderQueueProducer.retryDeadLettered).mockResolvedValue([
        'user-1',
      ]);

      await reconciliationService.reconcile(saleId);

      expect(orderQueueProducer.retryDeadLettered).toHaveBeenCalledWith(saleId);
      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledTimes(1);
      expect(orderQueueProducer.enqueuePersistOrder).toHaveBeenCalledWith(
        saleId,
        'user-2',
        expect.any(Date),
      );
    });
  });
});
