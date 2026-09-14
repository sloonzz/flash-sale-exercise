import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PERSIST_ORDER_ATTEMPTS } from '../config/env.ts';
import {
  PERSIST_ORDER_BACKOFF_TYPE,
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.ts';

@Injectable()
export class OrderQueueProducer {
  constructor(
    @InjectQueue(PERSIST_ORDER_QUEUE)
    private readonly queue: Queue<PersistOrderJobData>,
  ) {}

  async enqueuePersistOrder(
    saleId: string,
    userId: string,
    timestamp: Date,
  ): Promise<void> {
    await this.queue.add(
      'persist-order',
      { saleId, userId, timestamp: timestamp.toISOString() },
      {
        jobId: `${saleId}|${userId}`,
        attempts: PERSIST_ORDER_ATTEMPTS,
        // Delay is computed by the worker's backoffStrategy (see consumer)
        backoff: { type: PERSIST_ORDER_BACKOFF_TYPE },
        removeOnComplete: true,
      },
    );
  }

  countDeadLettered(): Promise<number> {
    return this.queue.getFailedCount();
  }

  async retryDeadLettered(saleId?: string): Promise<string[]> {
    const failed = await this.queue.getFailed();
    const jobs = saleId
      ? failed.filter((job) => job.data.saleId === saleId)
      : failed;
    const retried = await Promise.all(
      jobs.map(async (job) => {
        try {
          await job.retry('failed', { resetAttemptsMade: true });
          return job.data.userId;
        } catch (error) {
          if (isNotInFailedStateError(error)) return null;
          throw error;
        }
      }),
    );
    return retried.filter((userId): userId is string => userId !== null);
  }
}

function isNotInFailedStateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('is not in the failed state')
  );
}
