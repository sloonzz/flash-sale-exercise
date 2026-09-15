import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { AdminModule } from './admin/admin.module.ts';
import { AppController } from './app.controller.ts';
import { AppService } from './app.service.ts';
import { THROTTLE_DISABLED, THROTTLE_LIMIT } from './config/env.ts';
import { OrderModule } from './order/order.module.ts';
import { PrismaModule } from './prisma/prisma.module.ts';
import { PurchaseModule } from './purchase/purchase.module.ts';
import { ReconciliationModule } from './reconciliation/reconciliation.module.ts';
import { THROTTLE_REDIS_CLIENT } from './redis/redis.constants.ts';
import { ReservationModule } from './reservation/reservation.module.ts';
import { SaleModule } from './sale/sale.module.ts';

@Module({
  imports: [
    PrismaModule,
    // Global, so the ThrottlerGuard used by the purchase and admin modules
    // resolves without each of them re-registering the Redis storage. Counters
    // live on their own connection (see THROTTLE_REDIS_URL) so throttling
    // never contends with the reserve path.
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [THROTTLE_REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        throttlers: [
          { ttl: 1000, limit: THROTTLE_LIMIT, skipIf: () => THROTTLE_DISABLED },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    OrderModule,
    ReservationModule,
    ReconciliationModule,
    SaleModule,
    PurchaseModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
