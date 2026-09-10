import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { OrderModule } from './order/order.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReconciliationModule } from './reconciliation/reconciliation.module.js';
import { ReservationModule } from './reservation/reservation.module.js';

@Module({
  imports: [PrismaModule, OrderModule, ReservationModule, ReconciliationModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
