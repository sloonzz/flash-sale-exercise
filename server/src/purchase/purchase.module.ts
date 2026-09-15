import { Module } from '@nestjs/common';
import { SaleModule } from '../sale/sale.module.ts';
import { PurchaseController } from './purchase.controller.ts';

@Module({
  imports: [SaleModule],
  controllers: [PurchaseController],
})
export class PurchaseModule {}
