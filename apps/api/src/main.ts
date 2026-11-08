import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './interface/exception.filter';
import { seedDatabase } from './infrastructure/seed';
import { drainWebhooks } from './contexts/notification/webhook.service';
import { channelRouter } from './contexts/routing/router.service';

async function bootstrap(): Promise<void> {
  seedDatabase();

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableCors({ origin: true });

  // 生产形态：单端口同时托管前端构建产物与 API
  const webDist = path.resolve(process.cwd(), 'apps/web/dist');
  if (existsSync(webDist)) {
    const express = require('express') as {
      static(root: string): unknown;
    };
    const expressApp = app.getHttpAdapter().getInstance() as {
      use(...args: unknown[]): void;
    };
    expressApp.use(express.static(webDist));
    expressApp.use((req: { method: string; path: string }, res: any, next: () => void) => {
      if (
        req.method === 'GET' &&
        !req.path.startsWith('/api') &&
        !req.path.startsWith('/health')
      ) {
        res.sendFile(path.join(webDist, 'index.html'));
        return;
      }
      next();
    });
  }

  const port = Number(process.env.PORT || 3001);
  await app.listen(port, '127.0.0.1');

  // 后台任务：Outbox 派发与熔断器冷却
  setInterval(() => {
    void drainWebhooks().catch((error: Error) =>
      console.warn('[webhook]', error.message),
    );
  }, 1_500).unref();
  setInterval(() => channelRouter.tick(), 5_000).unref();
  app.enableShutdownHooks();

  console.log(`[PivotPay] API ready on http://127.0.0.1:${port}`);
  console.log(`[PivotPay] static web: ${existsSync(webDist) ? webDist : 'not built (use vite dev)'}`);
}

void bootstrap();
