import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  purchaseBodySchema,
  userIdSchema,
  type PurchaseBody,
  type PurchaseResponse,
  type SecuredResponse,
} from 'common';
import { ZodValidationPipe } from '../common/zod-validation.pipe.ts';
import { SaleService } from './sale.service.ts';

@Controller('purchase')
export class PurchaseController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  @UseGuards(ThrottlerGuard)
  async purchase(
    @Body(new ZodValidationPipe(purchaseBodySchema)) body: PurchaseBody,
  ): Promise<PurchaseResponse> {
    const result = await this.saleService.purchase(body.userId);
    return { result };
  }

  @Get(':userId')
  async checkSecured(
    @Param('userId', new ZodValidationPipe(userIdSchema)) userId: string,
  ): Promise<SecuredResponse> {
    const secured = await this.saleService.hasSecured(userId);
    return { secured };
  }
}
