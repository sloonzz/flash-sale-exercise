import { REDIS_URL } from '../config/env.ts';

const { hostname, port, password } = new URL(REDIS_URL);

export const BULL_REDIS_CONNECTION = {
  host: hostname,
  port: port ? Number(port) : 6379,
  ...(password ? { password } : {}),
  maxRetriesPerRequest: null,
};
