import { InventoryBizType, Prisma } from '@prisma/client';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateInboundBatchInput {
  productId!: string;
  warehouseId!: string;
  quantity!: Prisma.Decimal.Value;
  weightGram?: Prisma.Decimal.Value;
  unitCost!: Prisma.Decimal.Value;
  barcode?: string;
  sourceType!: string;
  sourceId!: string;
  bizType!: InventoryBizType;
  operatorId!: string;
  note?: string;
  attributes?: Prisma.InputJsonValue;
}

export class OutboundInput {
  batchId!: string;
  expectedProductId?: string;
  quantity!: Prisma.Decimal.Value;
  weightGram?: Prisma.Decimal.Value;
  sourceType!: string;
  sourceId!: string;
  bizType!: InventoryBizType;
  operatorId!: string;
  note?: string;
}

export class StocktakeAdjustInput {
  batchId!: string;
  countedQty!: Prisma.Decimal.Value;
  countedWeightGram?: Prisma.Decimal.Value;
  sourceType!: string;
  sourceId!: string;
  operatorId!: string;
}

export class TransformInput {
  @IsString()
  batchId!: string;

  @IsString()
  quantity!: Prisma.Decimal.Value;

  @IsOptional()
  @IsString()
  weightGram?: Prisma.Decimal.Value;
}

export class TransformOutput {
  @IsString()
  productId!: string;

  @IsString()
  warehouseId!: string;

  @IsString()
  quantity!: Prisma.Decimal.Value;

  @IsOptional()
  @IsString()
  weightGram?: Prisma.Decimal.Value;

  @IsOptional()
  @IsString()
  barcode?: string;
}

export class CompleteTransformDto {
  @IsIn(['SPLIT', 'MERGE'])
  transformType!: 'SPLIT' | 'MERGE';

  @IsString()
  createdById!: string;

  @IsArray()
  inputs!: TransformInput[];

  @IsArray()
  outputs!: TransformOutput[];
}
