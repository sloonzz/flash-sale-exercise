import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import { createCache, type Cache } from 'cache-manager';
import {
  currentSaleKey,
  serializeSale,
  type CachedSale,
} from './sale-cache.ts';
import { SaleService } from './sale.service.ts';
import type { OrderModel } from '../generated/prisma/models.ts';

describe('SaleService', () => {
  const prisma = {
    sale: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
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
  const cacheTtlMs = 1_000;
  let cache: Cache;
  let saleService: SaleService;

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
    vi.mocked(prisma.sale.findFirst).mockResolvedValue(null);
    cache = createCache({ ttl: cacheTtlMs });
    saleService = new SaleService(
      prisma,
      reservationService,
      reconciliationService,
      redis as unknown as Redis,
      cache,
    );
  });

  describe('getStatus', () => {
    it('reports no_sale when no sale has been configured', async () => {
      seedCurrentSale();

      await expect(saleService.getStatus()).resolves.toEqual({
        status: 'no_sale',
      });
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

    it('memoises the current sale in memory so repeat requests within the TTL skip Redis', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await saleService.getStatus();
      await saleService.getStatus();
      await saleService.purchase('user-1', sale.id);

      expect(redis.get).toHaveBeenCalledTimes(1);
    });

    it('re-reads the current sale from Redis once the in-memory TTL expires', async () => {
      vi.useFakeTimers();
      try {
        const sale = makeSale();
        seedCurrentSale(sale);
        vi.mocked(reservationService.getStock).mockResolvedValue(5);

        await saleService.getStatus();
        vi.advanceTimersByTime(cacheTtlMs + 1);
        await saleService.getStatus();

        expect(redis.get).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('memoises "no sale" so a quiet deployment does not hit Redis and Postgres on every poll', async () => {
      seedCurrentSale();

      await saleService.getStatus();
      await saleService.getStatus();

      expect(redis.get).toHaveBeenCalledTimes(1);
      expect(prisma.sale.findFirst).toHaveBeenCalledTimes(1);
    });

    it('recovers the current sale from Postgres and backfills the cache on a cache miss', async () => {
      const sale = makeSale();
      seedCurrentSale();
      vi.mocked(prisma.sale.findFirst).mockResolvedValue(sale as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await expect(saleService.getStatus()).resolves.toMatchObject({
        id: sale.id,
        product: sale.productName,
      });

      expect(prisma.sale.findFirst).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
      });
      expect(redis.set).toHaveBeenCalledWith(
        currentSaleKey(),
        serializeSale(sale),
      );
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

    it('answers soldout from the in-memory cache without reading stock once stock was seen exhausted', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(0);

      await saleService.getStatus();
      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'soldout',
      });

      expect(reservationService.getStock).toHaveBeenCalledTimes(1);
    });

    it('answers soldout from the cache when a purchase attempt already saw the sale sell out', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.reserve).mockResolvedValue('sold_out');

      await saleService.purchase('user-1', sale.id);
      await expect(saleService.getStatus()).resolves.toMatchObject({
        status: 'soldout',
      });

      expect(reservationService.getStock).not.toHaveBeenCalled();
    });

    it('re-reads stock once the sold-out cache entry expires', async () => {
      vi.useFakeTimers();
      try {
        const sale = makeSale();
        seedCurrentSale(sale);
        vi.mocked(reservationService.getStock).mockResolvedValue(0);

        await saleService.getStatus();
        vi.advanceTimersByTime(cacheTtlMs + 1);
        await saleService.getStatus();

        expect(reservationService.getStock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not cache active stock', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(1);

      await saleService.getStatus();
      await saleService.getStatus();

      expect(reservationService.getStock).toHaveBeenCalledTimes(2);
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

    it('answers sold_out from the in-memory cache without hitting Redis once a reservation reported sold out', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.reserve).mockResolvedValue('sold_out');

      await expect(saleService.purchase('user-1', sale.id)).resolves.toBe(
        'sold_out',
      );
      await expect(saleService.purchase('user-2', sale.id)).resolves.toBe(
        'sold_out',
      );

      expect(reservationService.reserve).toHaveBeenCalledTimes(1);
    });

    it('answers sold_out from the cache when a status check already saw stock exhausted', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.getStock).mockResolvedValue(0);

      await saleService.getStatus();
      await expect(saleService.purchase('user-1', sale.id)).resolves.toBe(
        'sold_out',
      );

      expect(reservationService.reserve).not.toHaveBeenCalled();
    });

    it('retries the reservation once the sold-out cache entry expires', async () => {
      vi.useFakeTimers();
      try {
        const sale = makeSale();
        seedCurrentSale(sale);
        vi.mocked(reservationService.reserve).mockResolvedValue('sold_out');

        await saleService.purchase('user-1', sale.id);
        vi.advanceTimersByTime(cacheTtlMs + 1);
        await saleService.purchase('user-2', sale.id);

        expect(reservationService.reserve).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not cache success or already_purchased results', async () => {
      const sale = makeSale();
      seedCurrentSale(sale);
      vi.mocked(reservationService.reserve)
        .mockResolvedValueOnce('success')
        .mockResolvedValueOnce('already_purchased');

      await saleService.purchase('user-1', sale.id);
      await saleService.purchase('user-1', sale.id);
      vi.mocked(reservationService.reserve).mockResolvedValue('success');
      await expect(saleService.purchase('user-2', sale.id)).resolves.toBe(
        'success',
      );

      expect(reservationService.reserve).toHaveBeenCalledTimes(3);
    });

    it('still reports ended over a cached sold_out once the window closes', async () => {
      vi.useFakeTimers();
      try {
        const sale = makeSale({ endTime: new Date(Date.now() + 500) });
        seedCurrentSale(sale);
        vi.mocked(reservationService.reserve).mockResolvedValue('sold_out');

        await saleService.purchase('user-1', sale.id);
        vi.advanceTimersByTime(501);

        await expect(saleService.purchase('user-2', sale.id)).resolves.toBe(
          'ended',
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getSecuredStatus', () => {
    it('is confirmed when a durable Order row exists, without consulting Redis', async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue({
        id: 'order-1',
      } as OrderModel);

      await expect(
        saleService.getSecuredStatus('user-1', 'sale-1'),
      ).resolves.toBe('confirmed');
      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { saleId_userId: { saleId: 'sale-1', userId: 'user-1' } },
        select: { id: true },
      });
      expect(reservationService.isReserved).not.toHaveBeenCalled();
    });

    it('is reserved when the Reservation exists but its Order has not landed', async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue(null);
      vi.mocked(reservationService.isReserved).mockResolvedValue(true);

      await expect(
        saleService.getSecuredStatus('user-1', 'sale-1'),
      ).resolves.toBe('reserved');
      expect(reservationService.isReserved).toHaveBeenCalledWith(
        'sale-1',
        'user-1',
      );
    });

    it('is none when there is neither an Order nor a Reservation', async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue(null);
      vi.mocked(reservationService.isReserved).mockResolvedValue(false);

      await expect(
        saleService.getSecuredStatus('user-1', 'sale-1'),
      ).resolves.toBe('none');
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

    it('drops everything this worker memoised about the previous sale', async () => {
      const created = makeSale(input);
      vi.mocked(prisma.sale.create).mockResolvedValue(created as never);
      await cache.set('/sale/status', { status: 'soldout' });

      await saleService.createSale(input);

      await expect(cache.get('/sale/status')).resolves.toBeUndefined();
    });

    it('primes the in-memory current sale so the creating worker serves it without a Redis read', async () => {
      const created = makeSale(input);
      vi.mocked(prisma.sale.create).mockResolvedValue(created as never);
      vi.mocked(reservationService.getStock).mockResolvedValue(5);

      await saleService.createSale(input);
      await expect(saleService.getStatus()).resolves.toMatchObject({
        id: created.id,
      });

      expect(redis.get).not.toHaveBeenCalled();
    });
  });
});
