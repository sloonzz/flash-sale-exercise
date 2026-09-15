import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import type {
  CreateSaleBody,
  PurchaseResult,
  SaleStatus,
  SecuredStatus,
  SaleStatusResponse,
} from 'common';
import { Redis } from 'ioredis';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import type { SaleModel } from '../generated/prisma/models.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import { ReservationService } from '../reservation/reservation.service.ts';
import {
  type CachedSale,
  currentSaleKey,
  serializeSale,
  deserializeSale,
  soldOutKey,
} from './sale-cache.ts';

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly reconciliationService: ReconciliationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  // Memory (per worker, TTL) → Redis (shared, no TTL) → Postgres (source).
  private async getCurrentSale(): Promise<CachedSale | null> {
    const memo = await this.cache.get<CachedSale | null>(currentSaleKey());
    if (memo !== undefined) {
      return memo;
    }

    const raw = await this.redis.get(currentSaleKey());
    if (raw !== null) {
      const sale = deserializeSale(raw);
      await this.cache.set(currentSaleKey(), sale);
      return sale;
    }

    const sale = await this.prisma.sale.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!sale) {
      await this.cache.set(currentSaleKey(), null);
      return null;
    }

    await this.cacheSale(sale);
    return sale;
  }

  private async cacheSale(sale: CachedSale): Promise<void> {
    await this.cache.set(currentSaleKey(), sale);
    await this.redis.set(currentSaleKey(), serializeSale(sale));
  }

  async getStatus(): Promise<SaleStatusResponse> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      return { status: 'no_sale' };
    }

    return {
      id: sale.id,
      status: await this.computeStatus(sale),
      startTime: sale.startTime.toISOString(),
      endTime: sale.endTime.toISOString(),
      product: sale.productName,
    };
  }

  async purchase(userId: string, saleId: string): Promise<PurchaseResult> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      return 'not_active';
    }
    if (sale.id !== saleId) {
      return 'invalid_sale';
    }

    switch (this.classifyWindow(sale)) {
      case 'before':
        return 'not_active';
      case 'after':
        return 'ended';
      case 'within': {
        if (await this.cache.get(soldOutKey(sale.id))) {
          return 'sold_out';
        }
        const result = await this.reservationService.reserve(sale.id, userId);
        if (result === 'sold_out') {
          await this.cache.set(soldOutKey(sale.id), true);
        }
        return result;
      }
    }
  }

  async getSecuredStatus(
    userId: string,
    saleId: string,
  ): Promise<SecuredStatus> {
    const order = await this.prisma.order.findUnique({
      where: { saleId_userId: { saleId, userId } },
      select: { id: true },
    });
    if (order) {
      return 'confirmed';
    }

    const reserved = await this.reservationService.isReserved(saleId, userId);
    return reserved ? 'reserved' : 'none';
  }

  async createSale(input: CreateSaleBody): Promise<SaleModel> {
    const sale = await this.prisma.sale.create({ data: input });

    // Everything this worker memoised (cached /sale/status response, sold-out
    // verdict) is about the previous sale; other workers catch up within a TTL.
    await this.cache.clear();
    await this.cacheSale(sale);
    await this.reconciliationService.reconcile(sale.id);

    return sale;
  }

  private async computeStatus(sale: CachedSale): Promise<SaleStatus> {
    switch (this.classifyWindow(sale)) {
      case 'before':
        return 'upcoming';
      case 'after':
        return 'ended';
      case 'within': {
        if (await this.cache.get(soldOutKey(sale.id))) {
          return 'soldout';
        }
        const stock = await this.reservationService.getStock(sale.id);
        if (stock !== null && stock <= 0) {
          await this.cache.set(soldOutKey(sale.id), true);
          return 'soldout';
        }
        return 'active';
      }
    }
  }

  private classifyWindow(sale: CachedSale): 'before' | 'within' | 'after' {
    const now = new Date();
    if (now < sale.startTime) {
      return 'before';
    }
    if (now > sale.endTime) {
      return 'after';
    }
    return 'within';
  }
}
