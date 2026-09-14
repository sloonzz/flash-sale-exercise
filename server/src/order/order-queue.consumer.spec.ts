import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.ts';
import { OrderQueueConsumer } from './order-queue.consumer.ts';
import { PersistOrderJobData } from './persist-order-job.ts';

describe('OrderQueueConsumer', () => {
  const consumer = new OrderQueueConsumer({} as PrismaService);
  const error = new Error('connection refused');

  const failedJob = (attemptsMade: number, attempts: number) =>
    ({
      id: 'sale-1|user-1',
      data: { saleId: 'sale-1', userId: 'user-1', timestamp: '' },
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job<PersistOrderJobData>;

  const spyOnErrorLog = () =>
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs an ordinary failure while attempts remain', () => {
    const errorLog = spyOnErrorLog();

    consumer.onFailed(failedJob(3, 50), error);

    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toContain('failed (attempt 3)');
    expect(errorLog.mock.calls[0][0]).not.toContain('DEAD-LETTERED');
  });

  it('logs a dead-letter alert naming the sale and user once attempts are exhausted', () => {
    const errorLog = spyOnErrorLog();

    consumer.onFailed(failedJob(50, 50), error);

    expect(errorLog).toHaveBeenCalledTimes(1);
    const message = errorLog.mock.calls[0][0] as string;
    expect(message).toContain('DEAD-LETTERED after 50 attempts');
    expect(message).toContain('user user-1');
    expect(message).toContain('sale sale-1');
    expect(errorLog.mock.calls[0][1]).toBe(error);
  });

  it('does not crash when BullMQ emits a failure without a job', () => {
    const errorLog = spyOnErrorLog();

    expect(() => consumer.onFailed(undefined, error)).not.toThrow();
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
