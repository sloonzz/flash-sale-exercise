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

  async listDeadLettered(saleId: string): Promise<string[]> {
    const failed = await this.queue.getFailed();
    return failed
      .filter((job) => job.data.saleId === saleId)
      .map((job) => job.data.userId);
  }
}
