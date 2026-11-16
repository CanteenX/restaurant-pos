/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call -- supertest bodies are untyped by design */
// Email templates (#220): CRUD, reset, preview, send-test, branding, auth and
// tenant isolation, plus the migrated senders. Runs against any migrated
// Postgres; creates and removes its own two throw-away restaurants. Email
// goes to an in-memory mock transport.
//   DATABASE_URL=... JWT_SECRET=x pnpm test:e2e -- email-templates
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
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
import { ReportSchedulesService } from './../src/modules/reports/report-schedules.service';
import { PrismaService } from './../src/prisma/prisma.service';

const tag = randomUUID().slice(0, 8);
const password = 'Password123!';
const BASE = '/api/v1/email-templates';

const customReset = {
  subject: 'Reset for {{user.name}}',
  heading: 'Hello {{user.name}}',
  body: 'Click **below**. [Help](https://help.example.com)',
  buttonText: 'Reset now',
  buttonUrl: '{{reset.url}}',
  footer: 'Thanks, {{restaurant.name}}',
  enabled: true,
};

describe('Email templates (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const sent: OutgoingEmail[] = [];
  const restaurantIds: string[] = [];
  const branchIds: string[] = [];
  let adminA: ReturnType<typeof request.agent>;
  let adminB: ReturnType<typeof request.agent>;
  let staffA: ReturnType<typeof request.agent>;

  const login = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(201);
    return agent;
  };

  const makeRestaurant = async (label: string, perms: string[]) => {
    const restaurant = await prisma.restaurant.create({
      data: { name: `${label} Bistro ${tag}` },
    });
    restaurantIds.push(restaurant.id);
    const branch = await prisma.branch.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Main',
        address: `${label} Street 1`,
      },
    });
    branchIds.push(branch.id);
    const permissions = await Promise.all(
      perms.map((key) =>
        prisma.permission.upsert({
          where: { key },
          update: {},
          create: { key, label: key, category: 'Admin' },
        }),
      ),
    );
    const passwordHash = await bcrypt.hash(password, 4);
    const mkUser = async (role: string, keys: typeof permissions) => {
      const r = await prisma.role.create({
        data: {
          restaurantId: restaurant.id,
          name: `${role}_${tag}`,
          label: role,
          permissions: {
            create: keys.map((p) => ({ permissionId: p.id })),
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
      return email;
    };
    return {
      restaurant,
      branch,
      admin: await mkUser('ADMIN', permissions),
      staff: await mkUser('STAFF', []),
    };
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
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

    const a = await makeRestaurant('Alpha', ['settings.emailTemplates']);
    const b = await makeRestaurant('Beta', ['settings.emailTemplates']);
    adminA = await login(a.admin);
    adminB = await login(b.admin);
    staffA = await login(a.staff);
  });

  afterAll(async () => {
    for (const id of restaurantIds) {
      await prisma.user.deleteMany({ where: { restaurantId: id } });
      await prisma.role.deleteMany({ where: { restaurantId: id } });
      await prisma.restaurant.delete({ where: { id } });
    }
    await app.close();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('needs a session and the settings.emailTemplates permission', async () => {
    await request(app.getHttpServer()).get(BASE).expect(401);
    await staffA.get(BASE).expect(403);
    await staffA.put(`${BASE}/PASSWORD_RESET`).send(customReset).expect(403);
    await staffA.post(`${BASE}/PASSWORD_RESET/preview`).send({}).expect(403);
    await staffA
      .post(`${BASE}/PASSWORD_RESET/test`)
      .send({ to: 'x@example.com' })
      .expect(403);
    await staffA.get(`${BASE}/branding`).expect(403);
  });

  it('lists the 6 code defaults before anything is saved', async () => {
    const res = await adminA.get(BASE).expect(200);
    expect(res.body.map((t: { key: string }) => t.key)).toEqual([
      'MARKETING_CAMPAIGN',
      'REPORT_SCHEDULED',
      'STOCK_ALERT',
      'RECEIPT',
      'STAFF_INVITE',
      'PASSWORD_RESET',
    ]);
    expect(res.body.every((t: { isCustom: boolean }) => !t.isCustom)).toBe(
      true,
    );
    expect(res.body[5].placeholders).toContain('reset.url');
  });

  it('returns 404 for an unknown template key', async () => {
    await adminA.get(`${BASE}/NOPE`).expect(404);
    await adminA.put(`${BASE}/NOPE`).send(customReset).expect(404);
  });

  it('saves a template, scoped to the caller restaurant only', async () => {
    const put = await adminA
      .put(`${BASE}/PASSWORD_RESET`)
      .send(customReset)
      .expect(200);
    expect(put.body).toMatchObject({
      isCustom: true,
      subject: customReset.subject,
    });
    const get = await adminA.get(`${BASE}/PASSWORD_RESET`).expect(200);
    expect(get.body.heading).toBe(customReset.heading);

    // Restaurant B still sees its own default and cannot touch A's copy.
    const other = await adminB.get(`${BASE}/PASSWORD_RESET`).expect(200);
    expect(other.body.isCustom).toBe(false);
    expect(other.body.subject).toBe('Reset your password');
    await adminB.post(`${BASE}/PASSWORD_RESET/reset`).expect(200);
    const still = await adminA.get(`${BASE}/PASSWORD_RESET`).expect(200);
    expect(still.body.isCustom).toBe(true);
    const previewB = await adminB
      .post(`${BASE}/PASSWORD_RESET/preview`)
      .send({})
      .expect(200);
    expect(previewB.body.subject).toBe('Reset your password');
    expect(previewB.body.html).not.toContain('Alpha Bistro');
  });

  it('rejects unknown placeholders, unsafe links and malformed bodies', async () => {
    const bad = await adminA
      .put(`${BASE}/REPORT_SCHEDULED`)
      .send({ ...customReset, buttonUrl: null, buttonText: null })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('{{user.name}}');
    await adminA
      .put(`${BASE}/PASSWORD_RESET`)
      .send({ ...customReset, body: '[x](javascript:alert(1))' })
      .expect(400);
    await adminA
      .put(`${BASE}/PASSWORD_RESET`)
      .send({ ...customReset, buttonUrl: 'data:text/html,hi' })
      .expect(400);
    await adminA
      .put(`${BASE}/PASSWORD_RESET`)
      .send({ ...customReset, html: '<b>x</b>' })
      .expect(400);
    await adminA
      .put(`${BASE}/PASSWORD_RESET`)
      .send({ ...customReset, subject: '' })
      .expect(400);
  });

  it('previews the saved template and an unsaved draft with sample data', async () => {
    const saved = await adminA
      .post(`${BASE}/PASSWORD_RESET/preview`)
      .send({})
      .expect(200);
    expect(saved.body.subject).toBe('Reset for Ravi Kumar');
    expect(saved.body.html).toContain(`Alpha Bistro ${tag}`);
    expect(saved.body.html).toContain('Alpha Street 1');
    expect(saved.body.html).toContain('<strong>below</strong>');
    expect(saved.body.text).toContain('Reset now: https://');

    const draft = await adminA
      .post(`${BASE}/RECEIPT/preview`)
      .send({
        draft: {
          subject: 'Receipt {{order.number}}',
          body: 'Hi <b>{{customer.name}}</b>',
        },
      })
      .expect(200);
    expect(draft.body.subject).toBe('Receipt #1042');
    expect(draft.body.html).toContain('Hi &lt;b&gt;Asha Rao&lt;/b&gt;');
    await adminA
      .post(`${BASE}/RECEIPT/preview`)
      .send({ draft: { subject: '{{reset.url}}' } })
      .expect(400);
  });

  it('updates branding and uses it when rendering', async () => {
    await adminA
      .put(`${BASE}/branding`)
      .send({ primaryColor: 'red' })
      .expect(400);
    await adminA
      .put(`${BASE}/branding`)
      .send({ primaryColor: '#123456', logoUrl: 'javascript:alert(1)' })
      .expect(400);
    const put = await adminA
      .put(`${BASE}/branding`)
      .send({
        primaryColor: '#0f766e',
        headerText: 'Alpha Kitchen',
        footerText: 'Open daily 9-11',
        replyTo: 'hello@alpha.example.com',
      })
      .expect(200);
    expect(put.body.primaryColor).toBe('#0F766E');
    const get = await adminA.get(`${BASE}/branding`).expect(200);
    expect(get.body.replyTo).toBe('hello@alpha.example.com');
    const b = await adminB.get(`${BASE}/branding`).expect(200);
    expect(b.body.headerText).toBeNull();
    const preview = await adminA
      .post(`${BASE}/STAFF_INVITE/preview`)
      .send({})
      .expect(200);
    expect(preview.body.html).toContain('background-color:#0F766E');
    expect(preview.body.html).toContain('Alpha Kitchen');
    expect(preview.body.html).toContain('Open daily 9-11');
  });

  it('sends a test email through the transport, then rate-limits', async () => {
    const res = await adminA
      .post(`${BASE}/PASSWORD_RESET/test`)
      .send({ to: 'Owner@Example.com' })
      .expect(200);
    expect(res.body).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'owner@example.com',
      subject: '[Test] Reset for Ravi Kumar',
      replyTo: 'hello@alpha.example.com',
    });
    expect(sent[0].html).toMatch(/^<!DOCTYPE html>/);
    expect(sent[0].text).toContain('Hello Ravi Kumar');
    await adminA
      .post(`${BASE}/PASSWORD_RESET/test`)
      .send({ to: 'not-an-email' })
      .expect(400);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push(
        (
          await adminA
            .post(`${BASE}/PASSWORD_RESET/test`)
            .send({ to: 'owner@example.com' })
        ).status,
      );
    expect(statuses).toContain(429);
  });

  it('resets a template back to the default', async () => {
    const res = await adminA.post(`${BASE}/PASSWORD_RESET/reset`).expect(200);
    expect(res.body).toMatchObject({
      isCustom: false,
      subject: 'Reset your password',
    });
    expect(
      await prisma.emailTemplate.count({
        where: { restaurantId: restaurantIds[0], key: 'PASSWORD_RESET' },
      }),
    ).toBe(0);
  });

  describe('migrated senders', () => {
    it('marketing emails are HTML + text and keep the unsubscribe link', async () => {
      const branchId = branchIds[0];
      await prisma.customer.create({
        data: {
          branchId,
          name: 'Mira <script>',
          phone: `+9100${tag}`,
          email: `mira-${tag}@example.com`,
        },
      });
      const campaign = await prisma.campaign.create({
        data: {
          branchId,
          name: `Diwali ${tag}`,
          channel: 'EMAIL',
          message: 'Sweets on us!\nSee you.',
        },
      });
      await app.get(MarketingService).send(branchId, campaign.id);
      expect(sent).toHaveLength(1);
      const mail = sent[0];
      expect(mail.subject).toBe(`Diwali ${tag}`);
      const url = /<(.+)>/.exec(mail.headers!['List-Unsubscribe'])![1];
      expect(mail.html).toContain(`href="${url}"`);
      expect(mail.html).toContain('Sweets on us!<br>See you.');
      expect(mail.text).toContain(`Unsubscribe: ${url}`);
      expect(mail.text).toContain('Sweets on us!\nSee you.');
    });

    it('a turned-off marketing template blocks the send and frees the slot', async () => {
      const branchId = branchIds[0];
      await adminA
        .put(`${BASE}/MARKETING_CAMPAIGN`)
        .send({
          subject: '{{campaign.name}}',
          body: '{{campaign.message}}',
          enabled: false,
        })
        .expect(200);
      const campaign = await prisma.campaign.create({
        data: { branchId, name: `Off ${tag}`, channel: 'EMAIL', message: 'x' },
      });
      await expect(
        app.get(MarketingService).send(branchId, campaign.id),
      ).rejects.toThrow(/turned off/);
      const after = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaign.id },
      });
      expect(after.lastSentAt).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('scheduled reports use the saved template and keep the attachment', async () => {
      const branchId = branchIds[1];
      await adminB
        .put(`${BASE}/REPORT_SCHEDULED`)
        .send({
          subject: 'Beta: {{report.title}} ({{report.period}})',
          heading: '{{report.title}}',
          body: 'Attached, for {{report.from}}.',
        })
        .expect(200);
      const schedule = await prisma.reportSchedule.create({
        data: {
          branchId,
          reportKey: 'sales-daily',
          frequency: 'DAILY',
          format: 'csv',
          recipients: [`boss-${tag}@example.com`],
        },
      });
      await app.get(ReportSchedulesService).deliver(schedule, '2026-11-16');
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toBe('Beta: Daily sales (2026-11-15)');
      expect(sent[0].html).toContain('Attached, for 2026-11-15.');
      expect(sent[0].text).toContain('Attached, for 2026-11-15.');
      expect(sent[0].attachments?.[0].filename).toBe(
        'sales-daily_2026-11-15_2026-11-15.csv',
      );
    });
  });
});
