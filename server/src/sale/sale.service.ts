import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateSaleBody,
  PurchaseResult,
  SaleStatus,
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
  currentSaleIdKey,
  saleKey,
  serializeSale,
  deserializeSale,
} from './sale-cache.ts';

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly reconciliationService: ReconciliationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // Only one sale is ever "current" -- creating a new one evicts the
  // previous one's cache entry (see cacheSale below), so there's no
  // multi-sale priority scan to run and no invalidation to reason about.
  private async getCurrentSale(): Promise<CachedSale | null> {
    const currentSaleId = await this.redis.get(currentSaleIdKey());
    return currentSaleId === null
      ? null
      : this.getCachedSaleById(currentSaleId);
  }

  private async getCachedSaleById(saleId: string): Promise<CachedSale | null> {
    const raw = await this.redis.get(saleKey(saleId));
    return raw === null ? null : deserializeSale(raw);
  }

  private async cacheSale(sale: CachedSale): Promise<void> {
    const previousId = await this.redis.get(currentSaleIdKey());

    const writes: Promise<unknown>[] = [
      this.redis.set(saleKey(sale.id), serializeSale(sale)),
      this.redis.set(currentSaleIdKey(), sale.id),
    ];
    if (previousId !== null && previousId !== sale.id) {
      writes.push(this.redis.del(saleKey(previousId)));
    }

    await Promise.all(writes);
  }

  async getStatus(): Promise<SaleStatusResponse> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      throw new NotFoundException('No sale has been configured');
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
    const sale = await this.getCachedSaleById(saleId);
    if (!sale) {
      // sale:{saleId} is only ever absent because no sale has been created
      // yet, or because a newer sale has since evicted it -- check which by
      // asking whether *any* sale is current. This keeps the common case
      // (the requested id matches the current sale) down to a single Redis
      // round trip instead of always resolving "current" first.
      const currentSaleId = await this.redis.get(currentSaleIdKey());
      return currentSaleId === null ? 'not_active' : 'invalid_sale';
    }

    switch (this.classifyWindow(sale)) {
      case 'before':
        return 'not_active';
      case 'after':
        return 'ended';
      case 'within':
        return this.reservationService.reserve(sale.id, userId);
    }
  }

  async hasSecured(userId: string, saleId: string): Promise<boolean> {
    return this.reservationService.isReserved(saleId, userId);
  }

  async createSale(input: CreateSaleBody): Promise<SaleModel> {
    const sale = await this.prisma.sale.create({ data: input });

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
        const stock = await this.reservationService.getStock(sale.id);
        return stock !== null && stock <= 0 ? 'soldout' : 'active';
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
