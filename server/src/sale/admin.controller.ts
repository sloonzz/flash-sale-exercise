import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminKeyGuard } from './admin-key.guard.ts';
import { requireNonEmptyString } from './request-validation.ts';
import { SaleService } from './sale.service.ts';
import type { CreateSaleInput } from './sale-types.ts';

interface CreateSaleRequestBody {
  productName?: unknown;
  totalStock?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

interface CreateSaleResponse {
  id: string;
  product: string;
  totalStock: number;
  startTime: string;
  endTime: string;
}

@Controller('admin/sales')
@UseGuards(AdminKeyGuard)
export class AdminController {
  constructor(private readonly saleService: SaleService) {}

  @Post()
  async createSale(
    @Body() body: CreateSaleRequestBody,
  ): Promise<CreateSaleResponse> {
    const input = parseCreateSaleBody(body);
    const sale = await this.saleService.createSale(input);

    return {
      id: sale.id,
      product: sale.productName,
      totalStock: sale.totalStock,
      startTime: sale.startTime.toISOString(),
      endTime: sale.endTime.toISOString(),
    };
  }
}

function parseCreateSaleBody(body: CreateSaleRequestBody): CreateSaleInput {
  const { productName, totalStock, startTime, endTime } = body;

  const parsedProductName = requireNonEmptyString(productName, 'productName');
  if (
    typeof totalStock !== 'number' ||
    !Number.isInteger(totalStock) ||
    totalStock < 0
  ) {
    throw new BadRequestException('totalStock must be a non-negative integer');
  }

  const parsedStartTime = parseDate(startTime, 'startTime');
  const parsedEndTime = parseDate(endTime, 'endTime');
  if (parsedStartTime >= parsedEndTime) {
    throw new BadRequestException('startTime must be before endTime');
  }

  return {
    productName: parsedProductName,
    totalStock,
    startTime: parsedStartTime,
    endTime: parsedEndTime,
  };
}

function parseDate(value: unknown, field: string): Date {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} is required`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} must be a valid date`);
  }
  return date;
}
