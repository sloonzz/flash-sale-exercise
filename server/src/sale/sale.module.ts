import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { THROTTLE_DISABLED, THROTTLE_LIMIT } from '../config/env.ts';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.ts';
import { REDIS_CLIENT } from '../redis/redis.constants.ts';
import { AdminAuthController } from './admin-auth.controller.ts';
import { AdminController } from './admin.controller.ts';
import { AdminKeyGuard } from './admin-key.guard.ts';
import { PurchaseController } from './purchase.controller.ts';
import { SaleController } from './sale.controller.ts';
import { SaleService } from './sale.service.ts';

@Module({
  imports: [
    ReconciliationModule,
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [
          { ttl: 1000, limit: THROTTLE_LIMIT, skipIf: () => THROTTLE_DISABLED },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
  ],
  controllers: [
    SaleController,
    PurchaseController,
    AdminController,
    AdminAuthController,
  ],
  providers: [SaleService, AdminKeyGuard],
})
export class SaleModule {}
