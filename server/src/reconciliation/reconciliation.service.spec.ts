import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { ReconciliationService } from './reconciliation.service.ts';

describe('ReconciliationService', () => {
  const prisma = {
    sale: { findUniqueOrThrow: vi.fn() },
    order: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const reservationService = {
    initializeStock: vi.fn().mockResolvedValue(undefined),
    seedReservedUsers: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReservationService;
  const reconciliationService = new ReconciliationService(
    prisma,
    reservationService,
  );

  beforeEach(() => {
    vi.clearAllMocks();
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
});
