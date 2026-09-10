import { Module } from '@nestjs/common';
import { AppController } from './app.controller.ts';
import { AppService } from './app.service.ts';
import { OrderModule } from './order/order.module.ts';
import { PrismaModule } from './prisma/prisma.module.ts';
import { ReconciliationModule } from './reconciliation/reconciliation.module.ts';
import { ReservationModule } from './reservation/reservation.module.ts';

@Module({
  imports: [PrismaModule, OrderModule, ReservationModule, ReconciliationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
