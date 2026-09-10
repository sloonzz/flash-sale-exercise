import { Global, Module } from '@nestjs/common';
import { ReservationService } from './reservation.service.ts';

@Global()
@Module({
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
