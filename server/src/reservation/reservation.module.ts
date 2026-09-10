import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.ts';
import { ReservationService } from './reservation.service.ts';

@Global()
@Module({
  imports: [RedisModule],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
