import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.js';

const PERSIST_ORDER_ATTEMPTS = 100_000;
const PERSIST_ORDER_BACKOFF_MS = 5_000;

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
        backoff: { type: 'fixed', delay: PERSIST_ORDER_BACKOFF_MS },
        removeOnComplete: true,
      },
    );
  }
}
