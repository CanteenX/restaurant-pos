import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

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
  const app = await NestFactory.create({
    module: ControlApiModule,
    controllers: auth ? [StaffController] : [],
    providers: auth ? [{ provide: StaffAuth, useValue: auth }] : [],
  }, { abortOnError: false });
  if (auth) {
    app.use('/api/control/v1/staff', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'POST' && req.headers.origin !== auth.origin) {
        res.statusCode = 403;
        res.end();
        return;
      }
      next();
    });
  }
  app.setGlobalPrefix('api/control/v1');
  return { app, port };
}
