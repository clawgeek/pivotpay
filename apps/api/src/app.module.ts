import { Module } from '@nestjs/common';
import { HttpController } from './interface/http.controller';
import { HealthController } from './interface/health.controller';

@Module({
  controllers: [HttpController, HealthController],
})
export class AppModule {}
