import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.ts';
import { RedisModule } from '../redis/redis.module.ts';
import { BULL_REDIS_CONNECTION } from './bull-connection.ts';
import { ORDER_OUTBOX_DEFAULT_KEY, ORDER_OUTBOX_KEY } from './order-outbox.ts';
import { OrderOutboxDrainer } from './order-outbox.drainer.ts';
import { OrderQueueConsumer } from './order-queue.consumer.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';
import { PERSIST_ORDER_QUEUE } from './persist-order-job.ts';

@Global()
@Module({
  imports: [
    PrismaModule,
    RedisModule,
    BullModule.forRoot({ connection: BULL_REDIS_CONNECTION }),
    BullModule.registerQueue({ name: PERSIST_ORDER_QUEUE }),
  ],
  providers: [
    { provide: ORDER_OUTBOX_KEY, useValue: ORDER_OUTBOX_DEFAULT_KEY },
    OrderQueueProducer,
    OrderQueueConsumer,
    OrderOutboxDrainer,
  ],
  exports: [ORDER_OUTBOX_KEY, OrderQueueProducer],
})
export class OrderModule {}
