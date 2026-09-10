import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.js';
import { persistOrder } from './persist-order.processor.js';

@Injectable()
export class OrderQueueConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderQueueConsumer.name);
  private readonly connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  private worker?: Worker<PersistOrderJobData>;

  constructor(private readonly prisma: PrismaService) {
    // An unhandled 'error' event on an ioredis connection crashes the
    // process; a worker connection blip must not take down the API.
    this.connection.on('error', (error) =>
      this.logger.error('Redis connection error', error),
    );
  }

  onModuleInit() {
    this.worker = new Worker<PersistOrderJobData>(
      PERSIST_ORDER_QUEUE,
      (job) => persistOrder(this.prisma, job.data),
      { connection: this.connection },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(
        `persist-order job ${job?.id} failed (attempt ${job?.attemptsMade})`,
        error,
      ),
    );
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.connection.quit();
  }
}
