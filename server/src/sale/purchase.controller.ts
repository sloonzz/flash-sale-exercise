import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { requireNonEmptyString } from './request-validation.ts';
import { SaleService } from './sale.service.ts';
import type { PurchaseResult } from './sale-types.ts';

interface PurchaseRequestBody {
  userId?: unknown;
}

@Controller('purchase')
export class PurchaseController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  async purchase(
    @Body() body: PurchaseRequestBody,
  ): Promise<{ result: PurchaseResult }> {
    const userId = requireNonEmptyString(body.userId, 'userId');
    const result = await this.saleService.purchase(userId);
    return { result };
  }

  @Get(':userId')
  async checkSecured(
    @Param('userId') userId: string,
  ): Promise<{ secured: boolean }> {
    const secured = await this.saleService.hasSecured(userId);
    return { secured };
  }
}
