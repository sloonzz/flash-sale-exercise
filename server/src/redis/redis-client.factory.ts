import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  REDIS_COMMAND_TIMEOUT_MS,
  REDIS_URL,
  THROTTLE_REDIS_URL,
} from '../config/env.ts';

function connect(url: string, name: string): Redis {
  const logger = new Logger(name);
  const client = new Redis(url, {
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  });
  client.on('error', (error) => logger.error('Redis connection error', error));
  return client;
}

export function createRedisClient(): Redis {
  return connect(REDIS_URL, 'RedisModule');
}

// Always a separate connection, even when THROTTLE_REDIS_URL is the same
// instance: a backed-up throttle pipeline then can't head-of-line-block the
// reserve script on a shared socket.
export function createThrottleRedisClient(): Redis {
  return connect(THROTTLE_REDIS_URL, 'ThrottleRedis');
}
