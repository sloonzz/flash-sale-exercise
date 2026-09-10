import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard.ts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.ts';
import { SaleService } from './sale.service.ts';
import { createSaleBodySchema } from './sale.schemas.ts';
import type { CreateSaleBody } from './sale.schemas.ts';

interface CreateSaleResponse {
  id: string;
  product: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}

@Controller('admin/sales')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  async createSale(
    @Body(new ZodValidationPipe(createSaleBodySchema)) body: CreateSaleBody,
  ): Promise<CreateSaleResponse> {
    const sale = await this.saleService.createSale(body);

    return {
      id: sale.id,
      product: sale.productName,
      totalStock: sale.totalStock,
      startTime: sale.startTime.toISOString(),
      endTime: sale.endTime.toISOString(),
    };
  }
}
