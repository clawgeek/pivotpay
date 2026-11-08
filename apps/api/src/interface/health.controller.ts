import { Controller, Get } from '@nestjs/common';
import { nowIso } from '../shared/kernel';
import { db } from '../infrastructure/database';
import { channelRouter } from '../contexts/routing/router.service';
import { consoleService } from '../application/admin.service';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): unknown {
    return { status: 'ok', at: nowIso() };
  }

  @Get('ready')
  ready(): unknown {
    const dbUp = db.isWritable();
    const available = channelRouter
      .listHealth()
      .filter((c) => c.enabled && c.configured && c.state !== 'OPEN')
      .map((c) => c.channelCode);
    const ready = dbUp && available.length > 0;
    return {
      status: ready ? 'ready' : 'degraded',
      database: dbUp ? 'up' : 'down',
      availableChannels: available,
      at: nowIso(),
    };
  }

  @Get('metrics')
  metrics(): unknown {
    return { ...consoleService.metrics(), at: nowIso() };
  }
}
