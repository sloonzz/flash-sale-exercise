import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.ts';
import { ReservationService } from '../reservation/reservation.service.ts';

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
