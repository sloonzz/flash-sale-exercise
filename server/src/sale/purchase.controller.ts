import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ZodValidationPipe } from '../common/zod-validation.pipe.ts';
import { SaleService } from './sale.service.ts';
import { purchaseBodySchema, userIdSchema } from './sale.schemas.ts';
import type { PurchaseBody } from './sale.schemas.ts';
import type { PurchaseResult } from './sale-types.ts';

@Controller('purchase')
export class PurchaseController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  async purchase(
    @Body(new ZodValidationPipe(purchaseBodySchema)) body: PurchaseBody,
  ): Promise<{ result: PurchaseResult }> {
    const result = await this.saleService.purchase(body.userId);
    return { result };
  }

  @Get(':userId')
  async checkSecured(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
  ): Promise<{ secured: boolean }> {
    const secured = await this.saleService.hasSecured(userId);
    return { secured };
  }
}
