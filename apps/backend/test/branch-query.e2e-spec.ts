import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../src/common/guards/permissions.guard';
import { BranchAccessService } from '../src/common/services/branch-access.service';
import { MenuController } from '../src/modules/menu/menu.controller';
import { MenuService } from '../src/modules/menu/menu.service';
import { OrdersController } from '../src/modules/orders/orders.controller';
import { OrdersService } from '../src/modules/orders/orders.service';
import { KotPrintService } from '../src/modules/orders/kot-print.service';
import { ReceiptEmailService } from '../src/modules/orders/receipt-email.service';
import { VerifactuService } from '../src/modules/verifactu/verifactu.service';

describe('menu and order branch query boundaries', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MenuController, OrdersController],
      providers: [
        { provide: MenuService, useValue: { listCategories: () => [] } },
        { provide: OrdersService, useValue: { listOpen: () => [] } },
        { provide: KotPrintService, useValue: {} },
        { provide: ReceiptEmailService, useValue: {} },
        { provide: VerifactuService, useValue: {} },
        {
          provide: BranchAccessService,
          useValue: {
            assertAccess: (_restaurant: string, branch: string) => {
              if (branch !== 'allowed') throw new ForbiddenException();
            },
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              user?: object;
            };
          };
        }) => {
          const req = context.switchToHttp().getRequest();
          if (!req.headers.authorization) return false;
          req.user = { restaurantId: 'restaurant' };
          return true;
        },
      })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it.each(['/v1/menu/categories', '/v1/orders'])(
    'validates %s',
    async (path) => {
      for (const suffix of [
        '',
        '?branchId=',
        '?branchId=%20%20',
        '?branchId=a&branchId=b',
      ]) {
        const res = await request(app.getHttpServer())
          .get(path + suffix)
          .set('Authorization', 'fixture')
          .expect(400);
        expect((res.body as { message: string }).message).toBe(
          'branchId is required',
        );
      }
      await request(app.getHttpServer())
        .get(path + '?branchId=other')
        .set('Authorization', 'fixture')
        .expect(403);
      await request(app.getHttpServer())
        .get(path + '?branchId=allowed')
        .set('Authorization', 'fixture')
        .expect(200);
      await request(app.getHttpServer()).get(path).expect(403);
    },
  );
});
