import { Module } from '@nestjs/common';
import { ConnectionController } from './connection.controller';
import { ConnectionService } from './connection.service';
import { VaultService } from './vault.service';

@Module({
  controllers: [ConnectionController],
  providers: [ConnectionService, VaultService],
  exports: [ConnectionService],
})
export class ConnectionModule {}
