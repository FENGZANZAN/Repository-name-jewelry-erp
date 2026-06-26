import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CompleteTransformDto } from './dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('batches')
  list(@Query('productId') productId?: string) {
    return this.inventory.listBatches(productId);
  }

  @Get('reconcile')
  reconcileAll() {
    return this.inventory.reconcileAll();
  }

  @Get('batches/:id/trace')
  trace(@Param('id') id: string) {
    return this.inventory.traceBatch(id);
  }

  @Get('batches/:id/reconcile')
  reconcile(@Param('id') id: string) {
    return this.inventory.reconcileBatch(id);
  }

  @Post('transform')
  transform(@Body() dto: CompleteTransformDto) {
    return this.inventory.transform(dto);
  }
}
