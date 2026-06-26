import { Module } from '@nestjs/common';
import { ErpSapCoreModule } from '../erp-sap-core/erp-sap-core.module';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [ErpSapCoreModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService]
})
export class InventoryModule {}
