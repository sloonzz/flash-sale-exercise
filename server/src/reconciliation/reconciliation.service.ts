import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReservationService } from '../reservation/reservation.service.js';

// Derives Redis's live Reservation state from Postgres's durable Orders.
// Safe to run any number of times: a first-time seed and a post-crash
// recovery are the same operation, since each Redis key is only ever
// populated when missing, never overwritten while live (see ADR-0001).
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationService: ReservationService,
  ) {}

  async reconcile(saleId: string): Promise<void> {
    const [sale, orders] = await Promise.all([
      this.prisma.sale.findUniqueOrThrow({ where: { id: saleId } }),
      this.prisma.order.findMany({
        where: { saleId },
        select: { userId: true },
      }),
    ]);

    const stock = sale.totalStock - orders.length;

    await Promise.all([
      this.reservationService.initializeStock(saleId, stock),
      this.reservationService.seedReservedUsers(
        saleId,
        orders.map((order) => order.userId),
      ),
    ]);
  }
}
