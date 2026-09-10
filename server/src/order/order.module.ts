import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.ts';
import { BULL_REDIS_CONNECTION } from './bull-connection.ts';
import { OrderQueueConsumer } from './order-queue.consumer.ts';
import { OrderQueueProducer } from './order-queue.producer.ts';
import { PERSIST_ORDER_QUEUE } from './persist-order-job.ts';

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
