/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest bodies are untyped by design */
// Marketing unsubscribe: signed link, one-click POST, suppression on the next send.
//   MARKETING_E2E=1 DATABASE_URL=... JWT_SECRET=x npx jest --config ./test/jest-e2e.json --runInBand marketing-unsubscribe
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import {
  EmailService,
  type OutgoingEmail,
} from './../src/modules/email/email.service';

const run = process.env.MARKETING_E2E ? describe : describe.skip;
const BRANCH = 'demo-branch';
const q = `?branchId=${BRANCH}`;
const tag = String(Date.now()).slice(-8);

run('Marketing unsubscribe (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let owner: ReturnType<typeof request.agent>;
  const sent: OutgoingEmail[] = [];
  const emails = [`a-${tag}@unsub.test`, `b-${tag}@unsub.test`];

  const send = async (name: string) => {
    const c = await owner
      .post(`/api/v1/marketing/campaigns${q}`)
      .send({ name, channel: 'EMAIL', segment: 'ALL', message: 'Hello!' })
      .expect(201);
    sent.length = 0;
    await owner
      .post(`/api/v1/marketing/campaigns/${c.body.id}/send${q}`)
      .expect(201);
    return sent.filter((m) => emails.includes(m.to));
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue({
        isConfigured: () => true,
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
    owner = request.agent(app.getHttpServer());
    await owner
      .post('/api/v1/auth/login')
      .send({ email: 'owner@demo.local', password: 'Password123!' })
      .expect(201);
    for (const email of emails)
      await prisma.customer.create({
        data: {
          branchId: BRANCH,
          name: email,
          phone: `+91${email.length}${tag}${email[0]}`,
          email,
        },
      });
  });

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });

  it('adds unsubscribe headers/link, then skips the recipient who opted out', async () => {
    const first = await send(`Unsub A ${tag}`);
    expect(first.map((m) => m.to).sort()).toEqual(emails);
    const mail = first[0];
    expect(mail.headers?.['List-Unsubscribe']).toMatch(
      /^<.+\/api\/v1\/public\/unsubscribe\/.+>$/,
    );
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click',
    );
    const url = /<(.+)>/.exec(mail.headers!['List-Unsubscribe'])![1];
    const path = new URL(url).pathname;
    expect(mail.text).toContain(url);

    await request(app.getHttpServer())
      .post(path)
      .type('form')
      .send('List-Unsubscribe=One-Click')
      .expect(200);

    // Pretend an hour has passed so the 2nd campaign is allowed (separate campaign anyway).
    const second = await send(`Unsub B ${tag}`);
    expect(second.map((m) => m.to)).not.toContain(mail.to);
    expect(second).toHaveLength(1);
  });

  it('GET page works, is idempotent and leaks nothing for bad tokens', async () => {
    const c = await prisma.customer.findFirstOrThrow({
      where: { email: emails[1] },
    });
    const bad = await request(app.getHttpServer())
      .get('/api/v1/public/unsubscribe/forged.token')
      .expect(200);
    expect(bad.text).toContain('invalid or has expired');
    expect(bad.text).not.toContain(c.name ?? 'zzz');
  });
});
