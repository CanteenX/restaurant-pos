import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import { createTransport } from 'nodemailer';

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: jest.fn().mockResolvedValue({}),
  })),
}));

describe('EmailService SMTP timeouts', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bounds connection, greeting and socket waits even when the URL overrides them', async () => {
    await makeService({
      SMTP_URL:
        'smtp://localhost:2525?socketTimeout=600000&connectionTimeout=600000&greetingTimeout=600000',
      SMTP_FROM: 'Cafe <cafe@example.com>',
    }).send({ to: 'guest@example.com', subject: 'Receipt', text: 'Receipt' });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'localhost',
        port: 2525,
        connectionTimeout: 60_000,
        greetingTimeout: 60_000,
        socketTimeout: 60_000,
      }),
    );
  });

  it('reuses its bounded transporter', async () => {
    const service = makeService({
      SMTP_URL: 'smtp://localhost:2525',
      SMTP_FROM: 'cafe@example.com',
    });
    const result = await service.sendEach([
      { to: 'guest@example.com', subject: 'Receipt', text: 'Receipt' },
      { to: 'guest@example.com', subject: 'Receipt', text: 'Receipt' },
    ]);
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('refuses sending when email is not configured', async () => {
    await expect(
      makeService({}).send({
        to: 'guest@example.com',
        subject: 'Receipt',
        text: 'Receipt',
      }),
    ).rejects.toThrow(/Email is not set up/);
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe('EmailService.sendEach logging', () => {
  it('logs only a count and error kind, never the address, subject or SMTP text', async () => {
    const service = makeService({});
    jest
      .spyOn(service, 'send')
      .mockRejectedValue(new Error('550 mailbox asha@example.com unknown'));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const out = await service.sendEach([
      { to: 'asha@example.com', subject: 'Hi Asha Rao', text: 'x' },
    ]);
    expect(out).toEqual({ sent: 0, failed: 1 });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toMatch(/asha|550/i);
    expect(logged).toContain('1 of 1');
    warn.mockRestore();
  });
});

function makeService(env: Record<string, string | undefined>): EmailService {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new EmailService(config);
}

describe('EmailService configuration', () => {
  it('is not configured and does not throw when SMTP is unset', () => {
    const service = makeService({});
    expect(service.isConfigured()).toBe(false);
  });

  it('needs both SMTP_URL and SMTP_FROM', () => {
    expect(
      makeService({
        SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
      }).isConfigured(),
    ).toBe(false);
    expect(
      makeService({ SMTP_FROM: 'My Cafe <hello@example.com>' }).isConfigured(),
    ).toBe(false);
  });

  it('is configured when both are set', () => {
    const service = makeService({
      SMTP_URL: 'smtps://user%40gmail.com:app-pass@smtp.gmail.com:465',
      SMTP_FROM: 'My Cafe <you@gmail.com>',
    });
    expect(service.isConfigured()).toBe(true);
  });

  it('treats empty strings (compose defaults) as unset', () => {
    const service = makeService({ SMTP_URL: '', SMTP_FROM: '' });
    expect(service.isConfigured()).toBe(false);
  });
});
