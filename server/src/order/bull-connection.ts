import { REDIS_URL } from '../config/env.js';

// BullMQ Workers issue blocking commands and require this flag; passing
// connection options (rather than our own ioredis instance) lets
// @nestjs/bullmq own the connection's lifecycle and error handling.
const { hostname, port, password } = new URL(REDIS_URL);

export const BULL_REDIS_CONNECTION = {
  host: hostname,
  port: port ? Number(port) : 6379,
  ...(password ? { password } : {}),
  maxRetriesPerRequest: null,
};
