import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import {
  currentSaleKey,
  serializeSale,
  type CachedSale,
} from './sale-cache.ts';
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
  const redis = {
    get: vi.fn(),
    set: vi.fn(),
  };
  const saleService = new SaleService(
    prisma,
    reservationService,
    reconciliationService,
    redis as unknown as Redis,
  );

  function makeSale(overrides: Partial<CachedSale> = {}): CachedSale {
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

  function seedCurrentSale(sale?: CachedSale): void {
    redis.get.mockResolvedValue(sale ? serializeSale(sale) : null);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getStatus', () => {
    it('throws when no sale has been configured', async () => {
      seedCurrentSale();

      await expect(saleService.getStatus()).rejects.toThrow(NotFoundException);
    });

    it('resolves the current sale from the cache instead of querying Postgres', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await saleService.getStatus();

      expect(redis.get).toHaveBeenCalledWith(currentSaleKey());
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    });

    it('reports upcoming before the start time', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      seedCurrentSale(sale);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'upcoming',
        product: sale.productName,
      });
      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('reports ended after the end time', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      seedCurrentSale(sale);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'ended',
      });
      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('reports active within the time window while stock remains', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'active',
      });
    });

    it('reports soldout within the time window once stock is exhausted', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(0);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'soldout',
        product: sale.productName,
      });
    });
  });

  describe('purchase', () => {
    it('rejects as not_active when no sale has been configured', async () => {
      seedCurrentSale();

      await expect(saleService.purchase('user-1', 'any-sale-id')).resolves.toBe(
        'not_active',
      );
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as not_active before the sale starts', async () => {
      const sale = makeSale({ startTime: new Date(Date.now() + 60_000) });
      seedCurrentSale(sale);

      await expect(saleService.purchase('user-1', sale.id)).resolves.toBe(
        'not_active',
      );
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('rejects as ended after the sale ends, without attempting a reservation', async () => {
      const sale = makeSale({ endTime: new Date(Date.now() - 60_000) });
      seedCurrentSale(sale);

      await expect(saleService.purchase('user-1', sale.id)).resolves.toBe(
        'ended',
      );
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('delegates to the Reservation module while the sale is active', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.reserve).mockResolvedValue('success');

      await expect(saleService.purchase('user-1', sale.id)).resolves.toBe(
        'success',
      );
      expect(reservationService.reserve).toHaveBeenCalledWith(
        sale.id,
        'user-1',
      );
    });

    it('rejects as invalid_sale when the caller purchases against a sale that is no longer current', async () => {
      const current = makeSale();
      seedCurrentSale(current);

      await expect(
        saleService.purchase('user-1', 'a-stale-sale-id'),
      ).resolves.toBe('invalid_sale');
      expect(reservationService.reserve).not.toHaveBeenCalled();
    });
  });

  describe('hasSecured', () => {
    it('reads the reserved-users state from the Reservation module for the given sale', async () => {
      vi.mocked(reservationService.isReserved).mockResolvedValue(true);

      await expect(saleService.hasSecured('user-1', 'sale-1')).resolves.toBe(
        true,
      );
      expect(reservationService.isReserved).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
      );
    });

    it('is false when the Reservation module has no record for the sale', async () => {
      vi.mocked(reservationService.isReserved).mockResolvedValue(false);

      await expect(saleService.hasSecured('user-1', 'sale-1')).resolves.toBe(
        false,
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

    it('appends a new sale row and overwrites the cached current sale', async () => {
      const created = makeSale(input);
      vi.mocked(prisma.sale.create).mockResolvedValue(created as never);

      await saleService.createSale(input);

      expect(prisma.sale.create).toHaveBeenCalledWith({ data: input });
      expect(prisma.sale.update).not.toHaveBeenCalled();
      expect(prisma.sale.findFirst).not.toHaveBeenCalled();
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        currentSaleKey(),
        serializeSale(created),
      );
      expect(reconciliationService.reconcile).toHaveBeenCalledWith(created.id);
    });
  });
});
