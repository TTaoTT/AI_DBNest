import { Controller, Get, Post, Delete, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ConnectionService } from './connection.service';
import { CreateConnectionDto, ExecuteQueryDto } from './dto';
import { supportedTypes } from './dialects';

@Controller('api/connections')
export class ConnectionController {
  constructor(private readonly svc: ConnectionService) {}

  @Get('types')
  types() {
    return supportedTypes();
  }

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() dto: CreateConnectionDto) {
    return this.svc.create(dto);
  }

  @Post('test')
  test(@Body() dto: CreateConnectionDto) {
    return this.svc.test(dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    this.svc.remove(id);
    return { ok: true };
  }

  @Get(':id/databases')
  databases(@Param('id') id: string) {
    return this.svc.getDatabases(id);
  }

  @Get(':id/tables')
  tables(@Param('id') id: string, @Query('db') db?: string) {
    return this.svc.getTables(id, db);
  }

  @Get(':id/tables/:table/columns')
  columns(
    @Param('id') id: string,
    @Param('table') table: string,
    @Query('schema') schema?: string,
  ) {
    return this.svc.describeTable(id, schema, table);
  }

  @Post(':id/query')
  @HttpCode(200)
  query(@Param('id') id: string, @Body() dto: ExecuteQueryDto) {
    return this.svc.executeQuery(id, dto);
  }
}
