import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { SaleService } from './sale.service.ts';

describe('SaleService', () => {
  const prisma = {
    sale: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.getStatus()).rejects.toThrow(NotFoundException);
    });

    it('reports upcoming before the start time', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'upcoming',
        product: sale.productName,
      });
      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('reports ended after the end time', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'ended',
      });
      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('reports active within the time window while stock remains', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'active',
      });
    });

    it('reports soldout within the time window once stock hits zero', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(0);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'soldout',
      });
    });
  });

  describe('purchase', () => {
    it('rejects as not_active when no sale has been configured', async () => {
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.purchase('user-1')).resolves.toBe('not_active');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as not_active before the sale starts, without touching Redis', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.purchase('user-1')).resolves.toBe('not_active');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as ended after the sale ends, without touching Redis', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);

      await expect(saleService.purchase('user-1')).resolves.toBe('ended');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('delegates to the Reservation module while the sale is active', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
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
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);

      await expect(saleService.hasSecured('user-1')).resolves.toBe(false);
    });

    it('reads the reserved-users state from the Reservation module', async () => {
      const sale = makeSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
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

    it('creates a new sale when none exists yet, then reconciles it', async () => {
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);
      const created = makeSale(input);
      vi.mocked(prisma.sale.create).mockResolvedValue(created as never);

      await saleService.createSale(input);

      expect(prisma.sale.create).toHaveBeenCalledWith({ data: input });
      expect(prisma.sale.update).not.toHaveBeenCalled();
      expect(reconciliationService.reconcile).toHaveBeenCalledWith(created.id);
    });

    it('reconfigures the existing sale row rather than creating a second one', async () => {
      const existing = makeSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(existing as never);
      const updated = { ...existing, ...input };
      vi.mocked(prisma.sale.update).mockResolvedValue(updated as never);

      await saleService.createSale(input);

      expect(prisma.sale.update).toHaveBeenCalledWith({
        where: { id: existing.id },
        data: input,
      });
      expect(prisma.sale.create).not.toHaveBeenCalled();
      expect(reconciliationService.reconcile).toHaveBeenCalledWith(existing.id);
    });
  });
});
