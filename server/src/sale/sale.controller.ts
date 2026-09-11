import { Controller, Get } from '@nestjs/common';
import type { SaleStatusResponse } from 'common';
import { SaleService } from './sale.service.ts';

@Controller('sale')
export class SaleController {
  constructor(private readonly saleService: SaleService) {}

  @Get('status')
  getStatus(): Promise<SaleStatusResponse> {
    return this.saleService.getStatus();
  }
}
