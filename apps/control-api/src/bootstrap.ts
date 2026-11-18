import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { readControlPort, readStaffConfig } from './config.js';
import { StaffAuth } from './staff/staff-auth.js';
import { StaffController } from './staff/staff.controller.js';

@Controller('health')
class HealthController {
  @Get()
  health() { return { status: 'ok' }; }
}

@Module({ controllers: [HealthController] })
class ControlApiModule {}

export async function createControlApi(env: NodeJS.ProcessEnv) {
  const port = readControlPort(env);
  const config = readStaffConfig(env);
  const auth = config && await StaffAuth.create(config.url, config.key, config.origin);
  const app = await NestFactory.create<NestExpressApplication>({
    module: ControlApiModule,
    controllers: auth ? [StaffController] : [],
    providers: auth ? [{ provide: StaffAuth, useValue: auth }] : [],
  }, { abortOnError: false, bodyParser: false });
  if (auth) {
    app.use('/api/control/v1/staff', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && req.headers.origin !== auth.origin) {
        res.statusCode = 403;
        res.end();
        return;
      }
      next();
    });
    app.useBodyParser('json', { limit: '8kb' });
    // Parse failures occur before controller filters and can contain credential fragments.
    app.use((err: Error & { status?: number }, _req: IncomingMessage,
      res: ServerResponse, next: (err: Error) => void) => {
      if (res.headersSent) return next(new Error('Invalid request body'));
      res.statusCode = err.status === 413 ? 413 : 400;
      res.end();
    });
  }
  app.setGlobalPrefix('api/control/v1');
  return { app, port };
}
