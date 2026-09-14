import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service.ts';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
  persistOrderBackoffDelay,
} from './persist-order-job.ts';
import { persistOrder } from './persist-order.processor.ts';

@Processor(PERSIST_ORDER_QUEUE, {
  lockDuration: 120_000,
  concurrency: 20,
  settings: {
    backoffStrategy: (attemptsMade) => persistOrderBackoffDelay(attemptsMade),
  },
})
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
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.onDeadLettered(job, error);
      return;
    }
    this.logger.error(
      `persist-order job ${job?.id} failed (attempt ${job?.attemptsMade})`,
      error,
    );
  }

  private onDeadLettered(job: Job<PersistOrderJobData>, error: Error) {
    this.logger.error(
      `persist-order job ${job.id} DEAD-LETTERED after ${job.attemptsMade} attempts: ` +
        `user ${job.data.userId} holds a Reservation on sale ${job.data.saleId} with no Order. ` +
        `Job left in 'failed' and will not be retried automatically — needs manual intervention.`,
      error,
    );
  }
}
