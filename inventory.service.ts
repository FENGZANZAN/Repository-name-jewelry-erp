import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BatchStatus, InventoryBatch, InventoryBizType, InventoryForm, Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { assertPositive, d } from '../common/decimal';
import { orderNo } from '../common/order-no';
import { AllocationEngine } from '../erp-sap-core/cost-center/allocation.engine';
import { PostingEngine } from '../erp-sap-core/gl/posting.engine';
import { AssetMapper } from '../erp-sap-core/gl/account.model';
import { CompleteTransformDto, CreateInboundBatchInput, OutboundInput, StocktakeAdjustInput } from './dto';

type Tx = Prisma.TransactionClient;
type OutboundResult = {
  batch: InventoryBatch;
  cost: Decimal;
  unitCost: Decimal;
  weightGram: Decimal;
};

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingEngine,
    private readonly assetMapper: AssetMapper,
    private readonly allocation: AllocationEngine
  ) {}

  async listBatches(productId?: string) {
    return this.prisma.inventoryBatch.findMany({
      where: { productId, status: { notIn: [BatchStatus.DEPLETED, BatchStatus.SOLD, BatchStatus.PROCESSED] } },
      include: { product: true, warehouse: true },
      orderBy: { createdAt: 'asc' }
    });
  }

  async traceBatch(batchId: string) {
    const batch = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
      include: {
        product: true,
        warehouse: true,
        purchaseLine: { include: { purchase: { include: { supplier: true } } } },
        logs: { orderBy: { happenedAt: 'asc' } },
        saleLines: { include: { saleOrder: true } }
      }
    });
    if (!batch) throw new NotFoundException('Batch not found');
    const processing = batch.sourceProcessingId
      ? await this.prisma.processingOrder.findUnique({
          where: { id: batch.sourceProcessingId },
          include: { inputs: true, outputs: true }
        })
      : null;
    const production = batch.sourceProcessingId
      ? await this.prisma.productionOrder.findUnique({
          where: { id: batch.sourceProcessingId },
          include: {
            inputs: { include: { batch: true, product: true } },
            outputs: { include: { batch: true, product: true } }
          }
        })
      : null;
    const transform = batch.sourceSplitMergeId
      ? await this.prisma.inventoryTransformOrder.findUnique({
          where: { id: batch.sourceSplitMergeId },
          include: { inputs: true, outputs: true }
        })
      : null;
    const costLedgers = await this.prisma.productionCostLedger.findMany({
      where: {
        OR: [
          { inputBatchId: batchId },
          { outputBatchId: batchId },
          ...(batch.sourceProcessingId ? [{ transformId: batch.sourceProcessingId }] : []),
          ...(batch.sourceSplitMergeId ? [{ transformId: batch.sourceSplitMergeId }] : [])
        ]
      },
      include: { inputBatch: true, outputBatch: true },
      orderBy: { createdAt: 'asc' }
    });
    const costAllocationResults = await this.prisma.costAllocationResult.findMany({
      where: { batchId },
      include: { glPosting: true },
      orderBy: { createdAt: 'asc' }
    });
    return { batch, source: { purchaseLine: batch.purchaseLine, processing, production, transform }, costLedgers, costAllocationResults };
  }

  async reconcileBatch(batchId: string) {
    return this.reconcileBatchWithClient(batchId, this.prisma);
  }

  async assertBatchIntegrity(batchId: string, tx: Tx = this.prisma) {
    const result = await this.reconcileBatchWithClient(batchId, tx);
    if (!result.chainOk) throw new BadRequestException(`库存异常：流水链断裂（批次 ${result.batchNo}）`);
    if (!result.drift.quantity.eq(0)) throw new BadRequestException(`库存异常：数量不一致（批次 ${result.batchNo}）`);
    if (!result.drift.weightGram.eq(0)) throw new BadRequestException(`库存异常：重量不一致（批次 ${result.batchNo}）`);
  }

  private async reconcileBatchWithClient(batchId: string, tx: Tx) {
    const batch = await tx.inventoryBatch.findUnique({
      where: { id: batchId },
      include: { product: true, warehouse: true }
    });
    if (!batch) throw new NotFoundException('Batch not found');

    const logs = await tx.inventoryLog.findMany({
      where: { batchId },
      orderBy: { happenedAt: 'asc' }
    });

    let ledgerQty = new Decimal(0);
    let ledgerWeight = new Decimal(0);
    let chainOk = true;
    for (const log of logs) {
      if (!d(log.beforeQty).eq(ledgerQty) || !d(log.beforeWeight).eq(ledgerWeight)) {
        chainOk = false;
      }
      ledgerQty = ledgerQty.add(log.quantityChange);
      ledgerWeight = ledgerWeight.add(log.weightChange);
      if (!d(log.afterQty).eq(ledgerQty) || !d(log.afterWeight).eq(ledgerWeight)) {
        chainOk = false;
      }
    }

    const balanceQty = d(batch.quantityOnHand);
    const balanceWeight = d(batch.weightGramOnHand);
    const driftQty = balanceQty.sub(ledgerQty);
    const driftWeight = balanceWeight.sub(ledgerWeight);

    return {
      batchId: batch.id,
      batchNo: batch.batchNo,
      product: batch.product,
      warehouse: batch.warehouse,
      logsCount: logs.length,
      current: {
        quantity: balanceQty,
        weightGram: balanceWeight,
        totalCost: batch.totalCostLocked,
        status: batch.status
      },
      ledger: {
        quantity: ledgerQty,
        weightGram: ledgerWeight
      },
      drift: {
        quantity: driftQty,
        weightGram: driftWeight
      },
      chainOk,
      ok: chainOk && driftQty.eq(0) && driftWeight.eq(0)
    };
  }

  async reconcileAll() {
    const batches = await this.prisma.inventoryBatch.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' }
    });
    const results = [];
    for (const batch of batches) {
      results.push(await this.reconcileBatch(batch.id));
    }
    return {
      ok: results.every((item) => item.ok),
      totalBatches: results.length,
      failedBatches: results.filter((item) => !item.ok),
      results
    };
  }

  async createInboundBatch(input: CreateInboundBatchInput, tx: Tx = this.prisma): Promise<InventoryBatch> {
    if (this.isRootClient(tx)) {
      return this.prisma.$transaction((transaction) => this.createInboundBatch(input, transaction), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    }
    assertPositive(input.quantity);
    assertPositive(input.unitCost, 'unitCost');

    const product = await tx.product.findUniqueOrThrow({ where: { id: input.productId } });
    const quantity = d(input.quantity);
    const weightGram = d(input.weightGram ?? 0);
    if (weightGram.lt(0)) throw new BadRequestException('weightGram cannot be negative');
    const unitCost = d(input.unitCost);
    const totalCost = quantity.mul(unitCost);
    const costPricePerGram = this.calculateCostPerGram(totalCost, weightGram);
    const assetAccount = await tx.glAccount.findUnique({
      where: { code: this.assetMapper.inventoryAccountCode(product.form) }
    });
    await this.allowInventoryWrite(tx);
    const batch = await tx.inventoryBatch.create({
      data: {
        batchNo: orderNo('B'),
        productId: input.productId,
        warehouseId: input.warehouseId,
        assetAccountId: assetAccount?.id,
        sourceType: this.resolveBatchSourceType(input.bizType),
        sourceId: input.sourceId,
        quantityOnHand: quantity,
        weightGramOnHand: weightGram,
        unitCostLocked: unitCost,
        totalCostLocked: totalCost,
        costPricePerGram,
        material: product.material,
        form: product.form,
        colorGrade: product.colorGrade,
        qualityGrade: product.qualityGrade,
        barcode: input.barcode,
        attributes: input.attributes,
        status: BatchStatus.AVAILABLE
      }
    });

    await tx.inventoryLog.create({
      data: {
        batchId: batch.id,
        productId: batch.productId,
        warehouseId: batch.warehouseId,
        bizType: input.bizType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        quantityChange: quantity,
        weightChange: weightGram,
        beforeQty: new Decimal(0),
        afterQty: quantity,
        beforeWeight: new Decimal(0),
        afterWeight: weightGram,
        unitCostLocked: unitCost,
        operatorId: input.operatorId,
        note: input.note
      }
    });
    await this.writeAudit(tx, input.operatorId, 'INVENTORY_IN', 'InventoryBatch', batch.id, null, batch);

    return batch;
  }

  async outbound(input: OutboundInput, tx: Tx = this.prisma): Promise<OutboundResult> {
    if (this.isRootClient(tx)) {
      return this.prisma.$transaction((transaction) => this.outbound(input, transaction), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    }
    assertPositive(input.quantity);
    const qty = d(input.quantity);
    const batch = await this.lockBatch(tx, input.batchId);
    if (!batch) throw new NotFoundException('Batch not found');
    await this.assertBatchIntegrity(input.batchId, tx);
    if (batch.status !== BatchStatus.ACTIVE && batch.status !== BatchStatus.AVAILABLE) {
      throw new BadRequestException('Batch is not available');
    }
    if (input.expectedProductId && batch.productId !== input.expectedProductId) {
      throw new BadRequestException('Batch product does not match operation product');
    }
    if (d(batch.quantityOnHand).lt(qty)) throw new BadRequestException('Insufficient inventory');

    const beforeQty = d(batch.quantityOnHand);
    const beforeWeight = d(batch.weightGramOnHand);
    const requestedWeight = input.weightGram
      ? d(input.weightGram)
      : beforeQty.eq(0)
        ? new Decimal(0)
        : beforeWeight.mul(qty).div(beforeQty);
    if (requestedWeight.lt(0)) throw new BadRequestException('weightGram cannot be negative');
    if (requestedWeight.gt(beforeWeight)) throw new BadRequestException('Insufficient inventory weight');
    const afterQty = beforeQty.sub(qty);
    const weightChangeAbs = afterQty.eq(0) ? beforeWeight : requestedWeight;
    const afterWeight = afterQty.eq(0) ? new Decimal(0) : beforeWeight.sub(weightChangeAbs);
    const afterTotalCost = afterQty.mul(batch.unitCostLocked);
    const status = afterQty.eq(0) ? this.resolveDepletedStatus(input.bizType) : BatchStatus.AVAILABLE;

    await this.allowInventoryWrite(tx);
    const updated = await tx.inventoryBatch.update({
      where: { id: input.batchId },
      data: {
        quantityOnHand: afterQty,
        weightGramOnHand: afterWeight,
        status,
        totalCostLocked: afterTotalCost,
        costPricePerGram: this.calculateCostPerGram(afterTotalCost, afterWeight)
      }
    });

    await tx.inventoryLog.create({
      data: {
        batchId: batch.id,
        productId: batch.productId,
        warehouseId: batch.warehouseId,
        bizType: input.bizType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        quantityChange: qty.neg(),
        weightChange: weightChangeAbs.neg(),
        beforeQty,
        afterQty,
        beforeWeight,
        afterWeight,
        unitCostLocked: batch.unitCostLocked,
        operatorId: input.operatorId,
        note: input.note
      }
    });
    await this.writeAudit(tx, input.operatorId, 'INVENTORY_OUT', 'InventoryBatch', batch.id, batch, updated);

    return {
      batch: updated,
      cost: qty.mul(batch.unitCostLocked),
      unitCost: batch.unitCostLocked,
      weightGram: weightChangeAbs
    };
  }

  async stocktakeAdjust(input: StocktakeAdjustInput, tx: Tx = this.prisma): Promise<InventoryBatch> {
    if (this.isRootClient(tx)) {
      return this.prisma.$transaction((transaction) => this.stocktakeAdjust(input, transaction), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    }
    const countedQty = d(input.countedQty);
    const countedWeight = d(input.countedWeightGram ?? 0);
    if (countedQty.lt(0)) throw new BadRequestException('countedQty cannot be negative');

    const batch = await this.lockBatch(tx, input.batchId);
    if (!batch) throw new NotFoundException('Batch not found');
    const beforeQty = d(batch.quantityOnHand);
    const beforeWeight = d(batch.weightGramOnHand);
    const afterWeight = input.countedWeightGram ? countedWeight : beforeWeight;
    if (afterWeight.lt(0)) throw new BadRequestException('countedWeightGram cannot be negative');
    const diff = countedQty.sub(beforeQty);
    const weightDiff = afterWeight.sub(beforeWeight);
    if (diff.eq(0) && weightDiff.eq(0)) return batch;

    const bizType = diff.gt(0) ? InventoryBizType.STOCKTAKE_GAIN : InventoryBizType.STOCKTAKE_LOSS;
    const stocktakeAmount = diff.abs().mul(batch.unitCostLocked);
    const afterTotalCost = countedQty.mul(batch.unitCostLocked);
    const status = countedQty.eq(0) ? BatchStatus.DEPLETED : BatchStatus.AVAILABLE;

    await this.allowInventoryWrite(tx);
    const updated = await tx.inventoryBatch.update({
      where: { id: batch.id },
      data: {
        quantityOnHand: countedQty,
        weightGramOnHand: afterWeight,
        status,
        totalCostLocked: afterTotalCost,
        costPricePerGram: this.calculateCostPerGram(afterTotalCost, afterWeight)
      }
    });

    await tx.inventoryLog.create({
      data: {
        batchId: batch.id,
        productId: batch.productId,
        warehouseId: batch.warehouseId,
        bizType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        quantityChange: diff,
        weightChange: weightDiff,
        beforeQty,
        afterQty: countedQty,
        beforeWeight,
        afterWeight,
        unitCostLocked: batch.unitCostLocked,
        operatorId: input.operatorId,
        note: 'stocktake committed'
      }
    });
    await this.writeAudit(tx, input.operatorId, 'INVENTORY_STOCKTAKE', 'InventoryBatch', batch.id, batch, updated);
    await this.posting.postStocktake(tx, {
      refId: `${input.sourceType}:${input.sourceId}:${batch.id}`,
      batchId: batch.id,
      amount: stocktakeAmount,
      direction: diff.gt(0) ? 'GAIN' : 'LOSS'
    });

    return updated;
  }

  async transform(dto: CompleteTransformDto) {
    if (!dto.inputs.length || !dto.outputs.length) {
      throw new BadRequestException('Transform must contain inputs and outputs');
    }
    this.validateTransformShape(dto);
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.inventoryTransformOrder.create({
        data: {
          orderNo: orderNo(dto.transformType === 'SPLIT' ? 'SP' : 'MG'),
          transformType: dto.transformType,
          createdById: dto.createdById
        }
      });

      let totalCost = new Decimal(0);
      const inputs = [...dto.inputs].sort((a, b) => a.batchId.localeCompare(b.batchId));
      const lockedInputs = [];
      const inputRecords: Array<{ batchId: string; amount: Decimal }> = [];
      const outputRecords: Array<{ batchId: string; amount: Decimal }> = [];
      for (const input of inputs) {
        const batch = await this.lockBatch(tx, input.batchId);
        if (!batch) throw new NotFoundException('Batch not found');
        lockedInputs.push({ input, batch });
      }
      this.validateTransformInventoryForms(dto.transformType, lockedInputs.map((item) => item.batch));

      for (const { input } of lockedInputs) {
        await this.assertBatchIntegrity(input.batchId, tx);
        const moved = await this.outbound(
          {
            batchId: input.batchId,
            quantity: input.quantity,
            weightGram: input.weightGram,
            sourceType: 'InventoryTransformOrder',
            sourceId: order.id,
            bizType: dto.transformType === 'SPLIT' ? InventoryBizType.SPLIT_CONSUME : InventoryBizType.MERGE_CONSUME,
            operatorId: dto.createdById,
            note: order.orderNo
          },
          tx
        );
        await tx.productionCostLedger.create({
          data: {
            transformId: order.id,
            inputBatchId: input.batchId,
            cost: moved.cost,
            weight: moved.weightGram
          }
        });
        totalCost = totalCost.add(moved.cost);
        inputRecords.push({ batchId: input.batchId, amount: moved.cost });
        await tx.inventoryTransformInput.create({
          data: {
            transformId: order.id,
            batchId: input.batchId,
            quantity: d(input.quantity),
            weightGram: moved.weightGram
          }
        });
      }

      const outputQty = dto.outputs.reduce((sum, item) => sum.add(item.quantity), new Decimal(0));
      const outputWeight = dto.outputs.reduce((sum, item) => sum.add(item.weightGram ?? 0), new Decimal(0));
      if (outputQty.lte(0)) throw new BadRequestException('Output quantity must be positive');
      if (outputWeight.lt(0)) throw new BadRequestException('Output weight cannot be negative');
      const outputUnitCost = totalCost.div(outputQty);
      const outputProducts = await tx.product.findMany({ where: { id: { in: dto.outputs.map((item) => item.productId) } } });
      if (outputProducts.length !== new Set(dto.outputs.map((item) => item.productId)).size) {
        throw new BadRequestException('Output product not found');
      }
      this.validateTransformOutputForms(dto.transformType, outputProducts);

      for (const output of dto.outputs) {
        const batch = await this.createInboundBatch(
          {
            productId: output.productId,
            warehouseId: output.warehouseId,
            quantity: output.quantity,
            weightGram: output.weightGram ?? 0,
            unitCost: outputUnitCost,
            barcode: output.barcode,
            sourceType: 'InventoryTransformOrder',
            sourceId: order.id,
            bizType: dto.transformType === 'SPLIT' ? InventoryBizType.SPLIT_OUTPUT : InventoryBizType.MERGE_OUTPUT,
            operatorId: dto.createdById,
            note: order.orderNo
          },
          tx
        );
        await tx.inventoryTransformOutput.create({
          data: {
            transformId: order.id,
            productId: output.productId,
            warehouseId: output.warehouseId,
            quantity: d(output.quantity),
            weightGram: d(output.weightGram ?? 0),
            barcode: output.barcode,
            batchId: batch.id
          }
        });
        await tx.inventoryBatch.update({
          where: { id: batch.id },
          data: { sourceSplitMergeId: order.id }
        });
        outputRecords.push({ batchId: batch.id, amount: batch.totalCostLocked });
      }

      await tx.inventoryTransformOrder.update({
        where: { id: order.id },
        data: { inputCost: totalCost, outputCost: totalCost }
      });
      const glPosting = await this.posting.postInventoryTransform(tx, {
        transformId: order.id,
        inputLines: inputRecords,
        outputLines: outputRecords
      }) as { id: string };
      await this.allocation.recordWeightedAverage(tx, {
        glPostingId: glPosting.id,
        lines: outputRecords.map((line) => ({ batchId: line.batchId, cost: line.amount }))
      });
      await this.writeAudit(tx, dto.createdById, `INVENTORY_${dto.transformType}`, 'InventoryTransformOrder', order.id, null, order);

      return tx.inventoryTransformOrder.findUniqueOrThrow({
        where: { id: order.id },
        include: { inputs: true, outputs: true }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async lockBatch(tx: Tx, batchId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "InventoryBatch" WHERE id = ${batchId} FOR UPDATE
    `;
    if (rows.length === 0) return null;
    return tx.inventoryBatch.findUniqueOrThrow({ where: { id: batchId } });
  }

  private async allowInventoryWrite(tx: Tx) {
    await tx.$executeRaw`SELECT set_config('app.inventory_write', 'on', true)`;
  }

  private isRootClient(tx: Tx) {
    return tx === this.prisma;
  }

  private calculateCostPerGram(totalCost: Decimal, weightGram: Decimal) {
    return weightGram.gt(0) ? totalCost.div(weightGram) : new Decimal(0);
  }

  private resolveDepletedStatus(bizType: InventoryBizType) {
    if (bizType === InventoryBizType.SALE_OUT) return BatchStatus.SOLD;
    if (
      bizType === InventoryBizType.PROCESSING_CONSUME ||
      bizType === InventoryBizType.SPLIT_CONSUME ||
      bizType === InventoryBizType.MERGE_CONSUME
    ) {
      return BatchStatus.PROCESSED;
    }
    return BatchStatus.DEPLETED;
  }

  private resolveBatchSourceType(bizType: InventoryBizType) {
    if (bizType === InventoryBizType.PURCHASE_IN) return 'purchase';
    if (
      bizType === InventoryBizType.PROCESSING_OUTPUT ||
      bizType === InventoryBizType.SPLIT_OUTPUT ||
      bizType === InventoryBizType.MERGE_OUTPUT
    ) {
      return 'production';
    }
    return 'production';
  }

  private validateTransformShape(dto: CompleteTransformDto) {
    if (dto.transformType === 'SPLIT' && dto.inputs.length !== 1) {
      throw new BadRequestException('Split must consume exactly one source batch');
    }
    if (dto.transformType === 'SPLIT' && dto.outputs.length < 2) {
      throw new BadRequestException('Split must produce at least two output batches');
    }
    if (dto.transformType === 'MERGE' && dto.inputs.length < 2) {
      throw new BadRequestException('Merge must consume at least two source batches');
    }
    if (dto.transformType === 'MERGE' && dto.outputs.length !== 1) {
      throw new BadRequestException('Merge must produce exactly one output batch');
    }
  }

  private validateTransformInventoryForms(
    transformType: 'SPLIT' | 'MERGE',
    batches: Array<{ form: InventoryForm }>
  ) {
    if (transformType === 'SPLIT' && batches.some((batch) => batch.form !== InventoryForm.ROUGH_STONE)) {
      throw new BadRequestException('Split inputs must be rough stone batches');
    }
    if (transformType === 'MERGE' && batches.some((batch) => batch.form !== InventoryForm.SCRAP)) {
      throw new BadRequestException('Merge inputs must be scrap batches');
    }
  }

  private validateTransformOutputForms(
    transformType: 'SPLIT' | 'MERGE',
    products: Array<{ form: InventoryForm }>
  ) {
    if (transformType === 'SPLIT' && products.some((product) => product.form === InventoryForm.ROUGH_STONE)) {
      throw new BadRequestException('Split outputs cannot be rough stone');
    }
    if (transformType === 'MERGE' && products.some((product) => product.form !== InventoryForm.SCRAP)) {
      throw new BadRequestException('Merge output must be scrap');
    }
  }

  private async writeAudit(tx: Tx, actorId: string | undefined, action: string, entityType: string, entityId: string, beforeState: unknown, afterState: unknown) {
    await tx.auditLog.create({
      data: {
        actorId,
        action,
        entityType,
        entityId,
        beforeState: beforeState == null ? undefined : this.toJson(beforeState),
        afterState: afterState == null ? undefined : this.toJson(afterState)
      }
    });
  }

  private toJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
