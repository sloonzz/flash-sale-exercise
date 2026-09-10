import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderQueueProducer } from './order-queue.producer.js';
import { PersistOrderJobData } from './persist-order-job.js';

describe('OrderQueueProducer', () => {
  const queue = {
    add: vi.fn().mockResolvedValue(undefined),
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
});
