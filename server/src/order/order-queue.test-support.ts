import { Queue } from 'bullmq';
import { BULL_REDIS_CONNECTION } from './bull-connection.js';
import {
  PERSIST_ORDER_QUEUE,
  PersistOrderJobData,
} from './persist-order-job.js';

// Specs construct services directly rather than through Nest's DI
// container (see ReservationService.spec.ts), so @InjectQueue needs a
// real Queue handed in by hand.
export function createTestQueue(): Queue<PersistOrderJobData> {
  return new Queue<PersistOrderJobData>(PERSIST_ORDER_QUEUE, {
    connection: BULL_REDIS_CONNECTION,
  });
}
