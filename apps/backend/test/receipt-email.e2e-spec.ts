/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- supertest bodies are untyped by design */
// Digital receipt email (#222): consent, one receipt per payment, resend with
// its own permission, the turned-off template, tenant isolation and amounts.
// Creates and removes its own throw-away restaurants; email goes to an
// in-memory mock transport.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e --runInBand receipt-email
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import {
  EmailService,
  type OutgoingEmail,
} from './../src/modules/email/email.service';
import { MarketingService } from './../src/modules/marketing/marketing.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { ReceiptEmailService } from './../src/modules/orders/receipt-email.service';

const tag = randomUUID().slice(0, 8);
const password = 'Password123!';
const ADMIN_PERMS = [
  'orders.create',
  'bills.print',
  'bills.resendReceipt',
  'settings.manage',
  'settings.emailTemplates',
  'menu.view',
];

interface Tenant {
  restaurantId: string;
  branchId: string;
  menuItemId: string;
  admin: ReturnType<typeof request.agent>;
  cashier: ReturnType<typeof request.agent>;
}

describe('Digital receipt email (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sent: OutgoingEmail[] = [];
  const restaurantIds: string[] = [];
  let a: Tenant;
  let b: Tenant;

  const login = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return agent;
  };

  const makeTenant = async (label: string): Promise<Tenant> => {
    const restaurant = await prisma.restaurant.create({
      data: { name: `${label} Bistro ${tag}` },
    });
    restaurantIds.push(restaurant.id);
    const branch = await prisma.branch.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Main',
        address: `${label} Street 1`,
        gstNumber: `29${label.toUpperCase()}1234F1Z5`,
      },
    });
    const category = await prisma.menuCategory.create({
      data: { branchId: branch.id, name: 'Mains' },
    });
    const item = await prisma.menuItem.create({
      data: {
        branchId: branch.id,
        categoryId: category.id,
        name: `Thali ${label}`,
        price: 210,
        taxRatePercent: 5,
      },
    });
    const passwordHash = await bcrypt.hash(password, 4);
    const mk = async (role: string, keys: string[]) => {
      const permissions = await Promise.all(
        keys.map((key) =>
          prisma.permission.upsert({
            where: { key },
            update: {},
            create: { key, label: key, category: 'Admin' },
          }),
        ),
      );
      const r = await prisma.role.create({
        data: {
          restaurantId: restaurant.id,
          name: `${role}_${tag}`,
          label: role,
          permissions: {
            create: permissions.map((p) => ({ permissionId: p.id })),
          },
        },
      });
      const email = `${role.toLowerCase()}-${label.toLowerCase()}-${tag}@example.com`;
      await prisma.user.create({
        data: {
          restaurantId: restaurant.id,
          roleId: r.id,
          name: role,
          email,
          passwordHash,
          branches: { create: { branchId: branch.id } },
        },
      });
      return login(email);
    };
    return {
      restaurantId: restaurant.id,
      branchId: branch.id,
      menuItemId: item.id,
      admin: await mk('ADMIN', ADMIN_PERMS),
      cashier: await mk('CASHIER', ['orders.create', 'bills.print']),
    };
  };

  const q = (t: Tenant) => `?branchId=${t.branchId}`;
  const newOrder = async (t: Tenant, quantity = 1) => {
    const res = await t.admin
      .post(`/api/v1/orders${q(t)}`)
      .send({
        type: 'TAKEAWAY',
        guestName: 'Walk-in',
        items: [{ menuItemId: t.menuItemId, quantity, modifierIds: [] }],
      })
      .expect(201);
    return res.body as { id: string };
  };
  const pay = (t: Tenant, id: string, body: object = {}) =>
    t.admin
      .post(`/api/v1/orders/${id}/checkout${q(t)}`)
      .send({ payments: [{ method: 'CASH', amount: 210 }], ...body });
  const waitFor = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const consent = {
    receiptEmail: 'guest@example.com',
    receiptEmailConsent: true,
  };

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
      .overrideProvider(EmailService)
      .useValue({
        isConfigured: () => true,
        send: (mail: OutgoingEmail) => {
          sent.push(mail);
          return Promise.resolve();
        },
        sendEach: (mails: OutgoingEmail[]) => {
          sent.push(...mails);
          return Promise.resolve({ sent: mails.length, failed: 0 });
        },
      })
      .compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
    prisma = app.get(PrismaService);
    a = await makeTenant('Alpha');
    b = await makeTenant('Beta');
    await a.admin
      .patch('/api/v1/settings/restaurant')
      .send({ digitalReceiptsEnabled: true })
      .expect(200);
  });

  afterAll(async () => {
    for (const id of restaurantIds) {
      await prisma.order.deleteMany({
        where: { branch: { restaurantId: id } },
      });
      await prisma.user.deleteMany({ where: { restaurantId: id } });
      await prisma.role.deleteMany({ where: { restaurantId: id } });
      await prisma.restaurant.delete({ where: { id } });
    }
    await app.close();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('sends one receipt after payment with the exact bill amounts', async () => {
    const o = await newOrder(a, 1);
    const res = await pay(a, o.id, consent).expect(201);
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail.to).toBe('guest@example.com');
    expect(mail.html).toMatch(/^<!DOCTYPE html>/);
    // The email shows the stored order totals untouched.
    const stored = await prisma.order.findUniqueOrThrow({
      where: { id: o.id },
    });
    const total = Number(stored.totalAmount).toFixed(2);
    expect(Number(res.body.totalAmount)).toBe(Number(stored.totalAmount));
    expect(mail.text).toContain(`Total: ₹${total}`);
    expect(mail.text).toContain(
      `Subtotal: ₹${Number(stored.subtotal).toFixed(2)}`,
    );
    expect(mail.text).toContain('1 × Thali Alpha');
    expect(mail.text).toContain('GSTIN: 29ALPHA1234F1Z5');
    expect(mail.text).toContain('Paid by CASH');
  });

  it('never sends twice for the same payment (replay)', async () => {
    const o = await newOrder(a);
    const requestId = `req-${randomUUID()}`;
    await pay(a, o.id, { ...consent, requestId }).expect(201);
    await waitFor(() => sent.length > 0);
    await pay(a, o.id, { ...consent, requestId }).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(1);
  });

  it.each(['success', 'failure'] as const)(
    'preserves the new claimant after the old SMTP attempt reports %s',
    async (outcome) => {
      const o = await newOrder(a);
      await pay(a, o.id, consent).expect(201);
      await waitFor(
        async () =>
          (await prisma.receiptEmail.findUnique({ where: { orderId: o.id } }))
            ?.status === 'SENT',
      );
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const pending = new Promise<void>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const smtp = jest
        .spyOn(app.get(EmailService), 'send')
        .mockImplementationOnce(() => pending);
      const receipts = app.get(ReceiptEmailService);
      const first = receipts.resend(
        a.restaurantId,
        o.id,
        (
          await prisma.user.findFirstOrThrow({
            where: { restaurantId: a.restaurantId },
          })
        ).id,
      );
      const firstResult = expect(first).rejects.toThrow(/could not be sent/);
      try {
        await waitFor(() => smtp.mock.calls.length === 1);
        const old = await prisma.receiptEmail.findUniqueOrThrow({
          where: { orderId: o.id },
        });
        expect(old.claimToken).toEqual(expect.any(String));
        await prisma.receiptEmail.update({
          where: { orderId: o.id },
          data: { updatedAt: new Date(0) },
        });
        await receipts.resend(
          a.restaurantId,
          o.id,
          (
            await prisma.user.findFirstOrThrow({
              where: { restaurantId: a.restaurantId },
            })
          ).id,
        );
        const current = await prisma.receiptEmail.findUniqueOrThrow({
          where: { orderId: o.id },
        });
        expect(current.status).toBe('SENT');
        expect(current.claimToken).toBeNull();
        expect(current.sendCount).toBe(2);
        if (outcome === 'success') resolve();
        else reject(new Error('synthetic SMTP failure'));
        await firstResult;
        expect(
          await prisma.receiptEmail.findUniqueOrThrow({
            where: { orderId: o.id },
          }),
        ).toEqual(current);
      } finally {
        resolve();
        await firstResult;
        smtp.mockRestore();
      }
    },
  );

  it('recovers an old stale SENDING row with no claim token', async () => {
    const o = await newOrder(a);
    await pay(a, o.id, consent).expect(201);
    await waitFor(
      async () =>
        (await prisma.receiptEmail.findUnique({ where: { orderId: o.id } }))
          ?.status === 'SENT',
    );
    await prisma.receiptEmail.update({
      where: { orderId: o.id },
      data: { status: 'SENDING', claimToken: null, updatedAt: new Date(0) },
    });
    await app.get(ReceiptEmailService).resend(
      a.restaurantId,
      o.id,
      (
        await prisma.user.findFirstOrThrow({
          where: { restaurantId: a.restaurantId },
        })
      ).id,
    );
    const row = await prisma.receiptEmail.findUniqueOrThrow({
      where: { orderId: o.id },
    });
    expect(row.status).toBe('SENT');
    expect(row.sendCount).toBe(2);
  });

  it('sends nothing without consent', async () => {
    const o = await newOrder(a);
    await pay(a, o.id, { receiptEmail: 'guest@example.com' }).expect(201);
    const o2 = await newOrder(a);
    await pay(a, o2.id, {
      receiptEmail: 'guest@example.com',
      receiptEmailConsent: false,
    }).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(0);
    expect(
      await prisma.receiptEmail.count({
        where: { orderId: { in: [o.id, o2.id] } },
      }),
    ).toBe(0);
  });

  it('sends nothing when digital receipts are switched off', async () => {
    const o = await newOrder(b);
    await pay(b, o.id, consent).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(0);
  });

  it('rejects a malformed address', async () => {
    const o = await newOrder(a);
    await pay(a, o.id, {
      receiptEmail: 'not-an-email',
      receiptEmailConsent: true,
    }).expect(400);
  });

  it('a partial payment waits; the receipt goes out when the bill is settled', async () => {
    const o = await newOrder(a, 2);
    await a.admin
      .post(`/api/v1/orders/${o.id}/checkout${q(a)}`)
      .send({
        ...consent,
        allowPartial: true,
        payments: [{ method: 'CASH', amount: 100 }],
      })
      .expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(0);
    await a.admin
      .post(`/api/v1/orders/${o.id}/checkout${q(a)}`)
      .send({ payments: [{ method: 'CASH', amount: 320 }] })
      .expect(201);
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });

  describe('receipt consent stays out of marketing', () => {
    it('a receipt-only guest is not a campaign recipient, and later receipts use only the consented address', async () => {
      const customer = await prisma.customer.create({
        data: { branchId: a.branchId, name: 'Receipt Only' },
      });
      const o1 = await newOrder(a);
      await pay(a, o1.id, { ...consent, customerId: customer.id }).expect(201);
      await waitFor(() => sent.length > 0);
      const saved = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect(saved.email).toBeNull();
      expect(saved.receiptEmail).toBe('guest@example.com');

      const campaign = await prisma.campaign.create({
        data: {
          branchId: a.branchId,
          name: `Promo ${tag}`,
          channel: 'EMAIL',
          message: 'Hello',
        },
      });
      const { recipients } = await app
        .get(MarketingService)
        .audience(a.branchId, campaign.id);
      expect(recipients.map((r) => r.id)).not.toContain(customer.id);

      // Staff later types a different address on the customer record.
      await prisma.customer.update({
        where: { id: customer.id },
        data: { email: 'typo@example.com' },
      });
      sent.length = 0;
      const o2 = await newOrder(a);
      await pay(a, o2.id, { customerId: customer.id }).expect(201);
      await waitFor(() => sent.length > 0);
      expect(sent.map((m) => m.to)).toEqual(['guest@example.com']);
    });

    it('a withdrawal is recorded even while digital receipts are off', async () => {
      const customer = await prisma.customer.create({
        data: {
          branchId: b.branchId,
          name: 'Opt Out',
          receiptEmail: 'optout@example.com',
          receiptConsentAt: new Date(),
        },
      });
      const o = await newOrder(b);
      await pay(b, o.id, {
        customerId: customer.id,
        receiptEmailConsent: false,
      }).expect(201);
      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect(after.receiptEmail).toBeNull();
    });
  });

  describe('resend', () => {
    let orderId: string;
    beforeAll(async () => {
      orderId = (await newOrder(a)).id;
      await pay(a, orderId, consent).expect(201);
      await waitFor(
        async () =>
          !!(await prisma.receiptEmail.findFirst({
            where: { orderId, status: 'SENT' },
          })),
      );
    });

    it('needs its own permission', async () => {
      await a.cashier
        .post(`/api/v1/orders/${orderId}/receipt-email/resend${q(a)}`)
        .expect(403);
    });

    it('is tenant isolated', async () => {
      await b.admin
        .post(`/api/v1/orders/${orderId}/receipt-email/resend${q(b)}`)
        .expect(404);
      await b.admin
        .post(`/api/v1/orders/${orderId}/receipt-email/resend${q(a)}`)
        .expect(403);
    });

    it('resends to the stored address and masks it in the status', async () => {
      await a.admin
        .post(`/api/v1/orders/${orderId}/receipt-email/resend${q(a)}`)
        .expect(200);
      expect(sent.at(-1)?.to).toBe('guest@example.com');
      const status = await a.cashier
        .get(`/api/v1/orders/${orderId}/receipt-email${q(a)}`)
        .expect(200);
      expect(status.body).toMatchObject({
        hasEmail: true,
        status: 'SENT',
        maskedEmail: 'g***@example.com',
      });
      expect(JSON.stringify(status.body)).not.toContain('guest@example.com');
    });

    it('explains itself when the template is turned off, and sends nothing automatically', async () => {
      const tpl = (
        await a.admin.get('/api/v1/email-templates/RECEIPT').expect(200)
      ).body;
      await a.admin
        .put('/api/v1/email-templates/RECEIPT')
        .send({
          subject: tpl.subject,
          heading: tpl.heading,
          body: tpl.body,
          buttonText: tpl.buttonText,
          buttonUrl: tpl.buttonUrl,
          footer: tpl.footer,
          enabled: false,
        })
        .expect(200);
      sent.length = 0;
      const o = await newOrder(a);
      await pay(a, o.id, consent).expect(201);
      await new Promise((r) => setTimeout(r, 300));
      expect(sent).toHaveLength(0);
      const res = await a.admin
        .post(`/api/v1/orders/${o.id}/receipt-email/resend${q(a)}`)
        .expect(409);
      expect(res.body.message).toMatch(/turned off/i);
      await a.admin.post('/api/v1/email-templates/RECEIPT/reset').expect(200);
    });

    it('is rate limited', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push(
          (
            await a.admin.post(
              `/api/v1/orders/${orderId}/receipt-email/resend${q(a)}`,
            )
          ).status,
        );
      expect(statuses).toContain(429);
    });
  });
});
