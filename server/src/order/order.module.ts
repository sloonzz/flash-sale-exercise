import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { OrderQueueConsumer } from './order-queue.consumer.js';
import { OrderQueueProducer } from './order-queue.producer.js';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [OrderQueueProducer, OrderQueueConsumer],
  exports: [OrderQueueProducer],
})
export class OrderModule {}
