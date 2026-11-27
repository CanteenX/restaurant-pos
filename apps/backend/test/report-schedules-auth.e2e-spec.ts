/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest responses are untyped */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('report schedules authorization (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let restaurantId: string;
  let branchId: string;
  let otherBranchId: string;
  let restrictedId: string;
  let otherId: string;
  let agent: ReturnType<typeof request.agent>;
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    const restaurant = await prisma.restaurant.create({
      data: { name: `Report auth ${tag}` },
    });
    restaurantId = restaurant.id;
    const branch = await prisma.branch.create({
      data: { restaurantId, name: 'Main', address: 'Test street' },
    });
    const otherBranch = await prisma.branch.create({
      data: { restaurantId, name: 'Other', address: 'Test street' },
    });
    branchId = branch.id;
    otherBranchId = otherBranch.id;
    const permissions = await Promise.all(
      ['reports.access', 'data.export'].map((key) =>
        prisma.permission.upsert({
          where: { key },
          update: {},
          create: { key, label: key, category: 'Reports' },
        }),
      ),
    );
    const role = await prisma.role.create({
      data: {
        restaurantId,
        name: `REPORT_${tag}`,
        label: 'Report test',
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
    });
    const email = `report-${tag}@example.com`;
    await prisma.user.create({
      data: {
        restaurantId,
        roleId: role.id,
        name: 'Report user',
        email,
        passwordHash: await bcrypt.hash('Password123!', 4),
        branches: { create: { branchId } },
      },
    });
    const make = (id: string, reportKey: string) =>
      prisma.reportSchedule.create({
        data: {
          branchId: id,
          reportKey,
          frequency: 'DAILY',
          format: 'csv',
          recipients: ['test@example.com'],
        },
      });
    restrictedId = (await make(branchId, 'sales-daily')).id;
    otherId = (await make(otherBranchId, 'sales-daily')).id;
    await make(branchId, 'waste');
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(201);
  });

  afterAll(async () => {
    await prisma.reportSchedule.deleteMany({
      where: { branchId: { in: [branchId, otherBranchId] } },
    });
    await prisma.user.deleteMany({ where: { restaurantId } });
    await prisma.role.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.delete({ where: { id: restaurantId } });
    await app.close();
  });

  it('filters restricted schedules and denies actions without the target report permission', async () => {
    const base = `/api/v1/report-schedules`;
    const list = await agent.get(base).query({ branchId }).expect(200);
    expect(
      list.body.schedules.map((s: { reportKey: string }) => s.reportKey),
    ).toEqual(['waste']);
    await agent
      .patch(`${base}/${restrictedId}`)
      .query({ branchId })
      .send({ isActive: false })
      .expect(403);
    await agent
      .post(`${base}/${restrictedId}/send`)
      .query({ branchId })
      .expect(403);
    await agent
      .delete(`${base}/${restrictedId}`)
      .query({ branchId })
      .expect(403);
    await agent.post(`${base}/${otherId}/send`).query({ branchId }).expect(404);
  });
});
