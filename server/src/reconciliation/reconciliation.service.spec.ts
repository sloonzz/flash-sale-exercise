import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderQueueProducer } from '../order/order-queue.producer.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { ReconciliationService } from './reconciliation.service.ts';

describe('ReconciliationService', () => {
  const prisma = {
    sale: { findUniqueOrThrow: vi.fn(), findFirst: vi.fn() },
    order: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const reservationService = {
    initializeStock: vi.fn().mockResolvedValue(undefined),
    seedReservedUsers: vi.fn().mockResolvedValue(undefined),
    getReservedUsers: vi.fn().mockResolvedValue([]),
  } as unknown as ReservationService;
  const orderQueueProducer = {
    enqueuePersistOrder: vi.fn().mockResolvedValue(undefined),
  } as unknown as OrderQueueProducer;
  const reconciliationService = new ReconciliationService(
    prisma,
    reservationService,
    orderQueueProducer,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(reservationService.getReservedUsers).mockResolvedValue([]);
  });

  describe('onApplicationBootstrap', () => {
    it('reconciles the most recently created sale', async () => {
      const saleId = randomUUID();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue({
        id: saleId,
      } as never);
      vi.mocked(prisma.sale.findUniqueOrThrow).mockResolvedValue({
        totalStock: 10,
      } as never);
      vi.mocked(prisma.order.findMany).mockResolvedValue([
        { userId: 'user-1' },
      ] as never);

      await reconciliationService.onApplicationBootstrap();

      expect(prisma.sale.findFirst).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(reservationService.initializeStock).toHaveBeenCalledWith(
        saleId,
        9,
      );
      expect(reservationService.seedReservedUsers).toHaveBeenCalledWith(
        saleId,
        ['user-1'],
      );
    });

    it('does nothing when no sale exists yet', async () => {
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await reconciliationService.onApplicationBootstrap();

      expect(prisma.sale.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(reservationService.initializeStock).not.toHaveBeenCalled();
      expect(reservationService.seedReservedUsers).not.toHaveBeenCalled();
    });

    it('logs and swallows reconciliation failures so the app still boots', async () => {
      vi.mocked(prisma.sale.findFirst).mockRejectedValue(
        new Error('redis down'),
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
    });
  });
});
