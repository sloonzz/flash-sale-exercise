import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.ts';
import { RedisModule } from '../redis/redis.module.ts';
import { ORDER_OUTBOX_DEFAULT_KEY, ORDER_OUTBOX_KEY } from './outbox/order-outbox.ts';
import { OrderOutboxDrainer } from './outbox/order-outbox.drainer.ts';
import { OrderOutboxService } from './outbox/order-outbox.service.ts';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    { provide: ORDER_OUTBOX_KEY, useValue: ORDER_OUTBOX_DEFAULT_KEY },
    OrderOutboxService,
    OrderOutboxDrainer,
  ],
  exports: [ORDER_OUTBOX_KEY, OrderOutboxService],
})
export class OrderModule {}
