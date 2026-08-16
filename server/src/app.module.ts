import { Module } from '@nestjs/common';
import { ConnectionModule } from './connection/connection.module';

@Module({
  imports: [ConnectionModule],
})
export class AppModule {}
