import { Inject, Injectable } from '@nestjs/common';
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
} from './sale-cache.ts';

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly reconciliationService: ReconciliationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private async getCurrentSale(): Promise<CachedSale | null> {
    const raw = await this.redis.get(currentSaleKey());
    if (raw !== null) {
      return deserializeSale(raw);
    }

    const sale = await this.prisma.sale.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (!sale) {
      return null;
    }

    await this.cacheSale(sale);
    return sale;
  }

  private async cacheSale(sale: CachedSale): Promise<void> {
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
      case 'within':
        return this.reservationService.reserve(sale.id, userId);
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
