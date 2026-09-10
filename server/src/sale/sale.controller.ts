import { Controller, Get } from '@nestjs/common';
import { SaleService } from './sale.service.ts';
import type { SaleStatusResponse } from './sale-types.ts';

@Controller('sale')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  @Get('status')
  getStatus(): Promise<SaleStatusResponse> {
    return this.saleService.getStatus();
  }
}
