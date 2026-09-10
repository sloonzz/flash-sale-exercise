import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createRedisClient } from './redis-client.factory.ts';
import { REDIS_CLIENT } from './redis.constants.ts';

@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useFactory: createRedisClient }],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
