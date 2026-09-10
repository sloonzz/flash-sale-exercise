import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_URL } from '../config/env.js';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.js';

// Per ADR-0001, the Order write is retried until it lands and never rolled
// back — so retries are numerous and closely spaced rather than a handful
// of exponentially-growing attempts.
const PERSIST_ORDER_ATTEMPTS = 100_000;
const PERSIST_ORDER_BACKOFF_MS = 5_000;

@Injectable()
export class OrderQueueProducer implements OnModuleDestroy {
  private readonly logger = new Logger(OrderQueueProducer.name);
  private readonly connection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  private readonly queue = new Queue<PersistOrderJobData>(PERSIST_ORDER_QUEUE, {
    connection: this.connection,
  });

  constructor() {
    // An unhandled 'error' event on an ioredis connection crashes the
    // process; a queue connection blip must not take down the API.
    this.connection.on('error', (error) =>
      this.logger.error('Redis connection error', error),
    );
  }

  async enqueuePersistOrder(
    saleId: string,
    userId: string,
    timestamp: Date,
  ): Promise<void> {
    await this.queue.add(
      'persist-order',
      { saleId, userId, timestamp: timestamp.toISOString() },
      {
        // One Reservation per user per sale (enforced in Redis) maps to one
        // queued job per user per sale: re-enqueuing is a no-op, not a
        // duplicate. BullMQ custom job ids may not contain ':'.
        jobId: `${saleId}|${userId}`,
        attempts: PERSIST_ORDER_ATTEMPTS,
        backoff: { type: 'fixed', delay: PERSIST_ORDER_BACKOFF_MS },
        removeOnComplete: true,
      },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
