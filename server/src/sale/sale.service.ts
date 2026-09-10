import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateSaleBody,
  PurchaseResult,
  SaleStatus,
  SaleStatusResponse,
} from 'common';
import { ReconciliationService } from '../reconciliation/reconciliation.service.ts';
import type { SaleModel } from '../generated/prisma/models.ts';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';

@Injectable()
export class SaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  private getCurrentSale(): Promise<SaleModel | null> {
    return this.prisma.sale.findFirst({ orderBy: { startTime: 'desc' } });
  }

  async getStatus(): Promise<SaleStatusResponse> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      throw new NotFoundException('No sale has been configured');
    }

    return {
      status: await this.computeStatus(sale),
      startTime: sale.startTime.toISOString(),
      endTime: sale.endTime.toISOString(),
      product: sale.productName,
    };
  }

  async purchase(userId: string): Promise<PurchaseResult> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      return 'not_active';
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

  async hasSecured(userId: string): Promise<boolean> {
    const sale = await this.getCurrentSale();
    if (!sale) {
      return false;
    }

    return this.reservationService.isReserved(sale.id, userId);
  }

  async createSale(input: CreateSaleBody): Promise<SaleModel> {
    const sale = await this.prisma.sale.create({ data: input });

    await this.reconciliationService.reconcile(sale.id);

    return sale;
  }

  private async computeStatus(sale: SaleModel): Promise<SaleStatus> {
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

  private classifyWindow(sale: SaleModel): 'before' | 'within' | 'after' {
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
