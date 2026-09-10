import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.ts';
import { AdminController } from './admin.controller.ts';
import { AdminKeyGuard } from './admin-key.guard.ts';
import { PurchaseController } from './purchase.controller.ts';
import { SaleController } from './sale.controller.ts';
import { SaleService } from './sale.service.ts';

@Module({
  imports: [
    ReconciliationModule,
    ThrottlerModule.forRoot([{ ttl: 1000, limit: 20 }]),
  ],
  controllers: [SaleController, PurchaseController, AdminController],
  providers: [SaleService, AdminKeyGuard],
})
export class SaleModule {}
