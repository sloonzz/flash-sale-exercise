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

  describe('listDeadLettered', () => {
    const failedJob = (saleId: string, userId: string) => ({
      data: { saleId, userId, timestamp: '2026-01-01T00:00:00.000Z' },
      retry: vi.fn(),
    });

    it('lists the users of failed jobs belonging to the given sale without touching them', async () => {
      const saleId = randomUUID();
      const mine = failedJob(saleId, 'user-1');
      const theirs = failedJob(randomUUID(), 'user-2');
      vi.mocked(queue.getFailed).mockResolvedValue([mine, theirs] as never);

      await expect(producer.listDeadLettered(saleId)).resolves.toEqual([
        'user-1',
      ]);
      expect(mine.retry).not.toHaveBeenCalled();
      expect(theirs.retry).not.toHaveBeenCalled();
    });

    it('returns an empty list when nothing is dead-lettered', async () => {
      vi.mocked(queue.getFailed).mockResolvedValue([]);

      await expect(producer.listDeadLettered(randomUUID())).resolves.toEqual(
        [],
      );
    });
  });
});
