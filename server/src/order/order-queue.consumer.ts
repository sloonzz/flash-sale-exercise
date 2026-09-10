import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.ts';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.ts';
import { persistOrder } from './persist-order.processor.ts';

@Processor(PERSIST_ORDER_QUEUE)
export class OrderQueueConsumer extends WorkerHost {
  private readonly logger = new Logger(OrderQueueConsumer.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<PersistOrderJobData>): Promise<void> {
    await persistOrder(this.prisma, job.data);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PersistOrderJobData> | undefined, error: Error) {
    this.logger.error(
      `persist-order job ${job?.id} failed (attempt ${job?.attemptsMade})`,
      error,
    );
  }
}
