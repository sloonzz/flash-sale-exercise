import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { MEMORY_CACHE_TTL_MS } from '../config/env.ts';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.ts';
import { SaleController } from './sale.controller.ts';
import { SaleService } from './sale.service.ts';

@Module({
  imports: [
    ReconciliationModule,
    CacheModule.register({ ttl: MEMORY_CACHE_TTL_MS }),
  ],
  controllers: [SaleController],
  providers: [SaleService],
  exports: [SaleService],
})
export class SaleModule {}
