import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { BULL_REDIS_CONNECTION } from './bull-connection.js';
import { OrderQueueConsumer } from './order-queue.consumer.js';
import { OrderQueueProducer } from './order-queue.producer.js';
import { PERSIST_ORDER_QUEUE } from './persist-order-job.js';

@Global()
@Module({
  imports: [
    PrismaModule,
    BullModule.forRoot({ connection: BULL_REDIS_CONNECTION }),
    BullModule.registerQueue({ name: PERSIST_ORDER_QUEUE }),
  ],
  providers: [OrderQueueProducer, OrderQueueConsumer],
  exports: [OrderQueueProducer],
})
export class OrderModule {}
