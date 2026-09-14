import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderQueueProducer } from './order-queue.producer.ts';
import { PersistOrderJobData } from './persist-order-job.ts';

describe('OrderQueueProducer', () => {
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
    getFailed: vi.fn().mockResolvedValue([]),
  } as unknown as Queue<PersistOrderJobData>;
  const producer = new OrderQueueProducer(queue);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a job carrying the sale id, user id, and timestamp', async () => {
    const saleId = randomUUID();
    const timestamp = new Date('2026-01-01T00:00:00.000Z');

    await producer.enqueuePersistOrder(saleId, 'user-1', timestamp);

    expect(queue.add).toHaveBeenCalledWith(
      'persist-order',
      { saleId, userId: 'user-1', timestamp: timestamp.toISOString() },
      // The per-sale-per-user jobId is what BullMQ dedups re-enqueues by
      // (verified against a real queue in order-queue.producer.integration.spec.ts).
      expect.objectContaining({ jobId: `${saleId}|user-1` }),
    );
  });

  describe('retryDeadLettered', () => {
    const failedJob = (saleId: string, userId: string) => ({
      data: { saleId, userId, timestamp: '2026-01-01T00:00:00.000Z' },
      retry: vi.fn().mockResolvedValue(undefined),
    });

    it('retries only the failed jobs belonging to the given sale', async () => {
      const saleId = randomUUID();
      const mine = failedJob(saleId, 'user-1');
      const theirs = failedJob(randomUUID(), 'user-2');
      vi.mocked(queue.getFailed).mockResolvedValue([mine, theirs] as never);

      const retried = await producer.retryDeadLettered(saleId);

      expect(retried).toEqual(['user-1']);
      expect(mine.retry).toHaveBeenCalledWith('failed', {
        resetAttemptsMade: true,
      });
      expect(theirs.retry).not.toHaveBeenCalled();
    });

    it('retries every failed job when no sale is given', async () => {
      const a = failedJob(randomUUID(), 'user-1');
      const b = failedJob(randomUUID(), 'user-2');
      vi.mocked(queue.getFailed).mockResolvedValue([a, b] as never);

      await expect(producer.retryDeadLettered()).resolves.toEqual([
        'user-1',
        'user-2',
      ]);
      expect(a.retry).toHaveBeenCalled();
      expect(b.retry).toHaveBeenCalled();
    });

    it('skips a job another replica already moved out of failed', async () => {
      const saleId = randomUUID();
      const raced = failedJob(saleId, 'user-1');
      raced.retry.mockRejectedValue(
        new Error(`Job ${saleId}|user-1 is not in the failed state. retryJob`),
      );
      const fine = failedJob(saleId, 'user-2');
      vi.mocked(queue.getFailed).mockResolvedValue([raced, fine] as never);

      await expect(producer.retryDeadLettered(saleId)).resolves.toEqual([
        'user-2',
      ]);
    });

    it('propagates any other retry error', async () => {
      const saleId = randomUUID();
      const broken = failedJob(saleId, 'user-1');
      broken.retry.mockRejectedValue(new Error('connection lost'));
      vi.mocked(queue.getFailed).mockResolvedValue([broken] as never);

      await expect(producer.retryDeadLettered(saleId)).rejects.toThrow(
        'connection lost',
      );
    });

    it('returns an empty list when nothing is dead-lettered', async () => {
      vi.mocked(queue.getFailed).mockResolvedValue([]);

      await expect(producer.retryDeadLettered(randomUUID())).resolves.toEqual(
        [],
      );
    });
  });
});
