import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { readControlPort } from './config.js';

@Controller('health')
class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}

@Module({ controllers: [HealthController] })
class ControlApiModule {}

export async function createControlApi(env: NodeJS.ProcessEnv) {
  const port = readControlPort(env);
  const app = await NestFactory.create(ControlApiModule, { abortOnError: false });
  app.setGlobalPrefix('api/control/v1');
  return { app, port };
}
