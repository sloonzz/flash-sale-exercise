import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { SaleService } from './sale.service.ts';

describe('SaleService', () => {
  const prisma = {
    sale: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as PrismaService;
  const reservationService = {
    reserve: vi.fn(),
    getStock: vi.fn(),
    isReserved: vi.fn(),
  } as unknown as ReservationService;
  const reconciliationService = {
    reconcile: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReconciliationService;
  const saleService = new SaleService(
    prisma,
    reservationService,
    reconciliationService,
  );

  function makeSale(
    overrides: Partial<{
      id: string;
      productName: string;
      totalStock: number;
      startTime: Date;
      endTime: Date;
    }> = {},
  ) {
    const now = Date.now();
    return {
      id: randomUUID(),
      productName: 'Widget',
      totalStock: 10,
      startTime: new Date(now - 60_000),
      endTime: new Date(now + 60_000),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('throws when no sale has been configured', async () => {
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.getStatus()).rejects.toThrow(NotFoundException);
    });

    it('fetches the earliest sale that is not out of stock and not done yet', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await saleService.getStatus();

      expect(prisma.sale.findMany).toHaveBeenCalledWith({
        where: { endTime: { gte: expect.any(Date) } },
        orderBy: { startTime: 'asc' },
      });
      expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    });

    it('selects the earliest open sale when multiple candidates exist', async () => {
      const earlier = makeSale({ productName: 'Earlier' });
      const later = makeSale({ productName: 'Later' });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([
        earlier,
        later,
      ] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        product: 'Earlier',
      });
      expect(reservationService.getStock).not.toHaveBeenCalledWith(later.id);
    });

    it('skips a sold-out earlier sale in favor of the next open one', async () => {
      const soldOut = makeSale({ productName: 'Sold Out' });
      const open = makeSale({ productName: 'Open' });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([
        soldOut,
        open,
      ] as never);
      vi.mocked(reservationService.getStock).mockImplementation((saleId) =>
        Promise.resolve(saleId === soldOut.id ? 0 : 5),
      );

      await expect(saleService.getStatus()).resolves.toMatchObject({
        product: 'Open',
      });
      expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the sale with the latest start time when every sale is sold out', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(0);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'soldout',
        product: sale.productName,
      });
      expect(prisma.sale.findFirst).toHaveBeenCalledWith({
        orderBy: { startTime: 'desc' },
      });
    });

    it('reports upcoming before the start time', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(null);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'upcoming',
        product: sale.productName,
      });
    });

    it('reports ended after the end time by falling back to the latest start time', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'ended',
      });
      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('reports active within the time window while stock remains', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'active',
      });
    });
  });

  describe('purchase', () => {
    it('rejects as not_active when no sale has been configured', async () => {
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.purchase('user-1')).resolves.toBe('not_active');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as not_active before the sale starts', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(null);

      await expect(saleService.purchase('user-1')).resolves.toBe('not_active');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as ended after the sale ends, without touching Redis', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.purchase('user-1')).resolves.toBe('ended');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('delegates to the Reservation module while the sale is active', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);
      vi.mocked(reservationService.reserve).mockResolvedValue('success');

      await expect(saleService.purchase('user-1')).resolves.toBe('success');
      expect(reservationService.reserve).toHaveBeenCalledWith(
        sale.id,
        'user-1',
      );
    });
  });

  describe('hasSecured', () => {
    it('is false when no sale has been configured', async () => {
      vi.mocked(prisma.sale.findMany).mockResolvedValue([]);
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.hasSecured('user-1')).resolves.toBe(false);
    });

    it('reads the reserved-users state from the Reservation module', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findMany).mockResolvedValue([sale] as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);
      vi.mocked(reservationService.isReserved).mockResolvedValue(true);

      await expect(saleService.hasSecured('user-1')).resolves.toBe(true);
      expect(reservationService.isReserved).toHaveBeenCalledWith(
        sale.id,
        'user-1',
      );
    });
  });

  describe('createSale', () => {
    const input = {
      productName: 'Widget',
      totalStock: 10,
      startTime: new Date(),
      endTime: new Date(Date.now() + 60_000),
    };

    it('appends a new sale row rather than overwriting the existing one', async () => {
      const created = makeSale(input);
      vi.mocked(prisma.sale.create).mockResolvedValue(created as never);

      await saleService.createSale(input);

      expect(prisma.sale.create).toHaveBeenCalledWith({ data: input });
      expect(prisma.sale.update).not.toHaveBeenCalled();
      expect(prisma.sale.findFirst).not.toHaveBeenCalled();
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(reconciliationService.reconcile).toHaveBeenCalledWith(created.id);
    });
  });
});
