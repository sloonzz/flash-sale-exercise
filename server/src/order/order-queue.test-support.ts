import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { BULL_REDIS_CONNECTION } from './bull-connection.js';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.js';

export function createTestQueue(): Queue<PersistOrderJobData> {
  return new Queue<PersistOrderJobData>(
    `${PERSIST_ORDER_QUEUE}-test-${randomUUID()}`,
    { connection: BULL_REDIS_CONNECTION },
  );
}
