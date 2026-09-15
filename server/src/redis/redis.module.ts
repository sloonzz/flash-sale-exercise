import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  createRedisClient,
  createThrottleRedisClient,
} from './redis-client.factory.ts';
import { REDIS_CLIENT, THROTTLE_REDIS_CLIENT } from './redis.constants.ts';

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, useFactory: createRedisClient },
    { provide: THROTTLE_REDIS_CLIENT, useFactory: createThrottleRedisClient },
  ],
  exports: [REDIS_CLIENT, THROTTLE_REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    @Inject(THROTTLE_REDIS_CLIENT) private readonly throttleClient: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.client.quit(), this.throttleClient.quit()]);
  }
}
