import { REDIS_URL } from '../config/env.ts';

const { hostname, port, password, pathname } = new URL(REDIS_URL);
const db = pathname.slice(1);

export const BULL_REDIS_CONNECTION = {
  host: hostname,
  port: port ? Number(port) : 6379,
  ...(password ? { password } : {}),
  ...(db ? { db: Number(db) } : {}),
  maxRetriesPerRequest: null,
};
