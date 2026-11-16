import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { emailTemplateTestSchema } from '@nventra/types';
import { EmailTemplatesController } from './email-templates.controller';
import { EmailTemplatesService } from './email-templates.service';

const OWN = 'admin@alpha.example.com';

function makeService(opts: { userEmail?: string | null } = {}) {
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue({
        email: opts.userEmail === undefined ? OWN : opts.userEmail,
      }),
    },
    emailTemplate: { findUnique: jest.fn().mockResolvedValue(null) },
    emailBranding: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ primaryColor: '#9F1239', replyTo: 'x@y.co' }),
    },
    restaurant: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ name: 'Alpha', branches: [{ address: 'St 1' }] }),
    },
  };
  const email = {
    isConfigured: () => true,
    send: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new EmailTemplatesService(
    prisma as never,
    email as never,
    config,
  );
  return { service, email, prisma };
}

describe('EmailTemplatesService.sendTest', () => {
  afterEach(() => jest.useRealTimers());

  it("always sends to the acting user's own account email", async () => {
    const { service, email, prisma } = makeService();
    await service.sendTest('r1', 'u1', 'PASSWORD_RESET');
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u1', restaurantId: 'r1' } }),
    );
    expect(email.send).toHaveBeenCalledTimes(1);
    expect((email.send.mock.calls[0] as [{ to: string }])[0].to).toBe(OWN);
  });

  it('refuses when the user has no email on their account', async () => {
    const { service, email } = makeService({ userEmail: null });
    await expect(
      service.sendTest('r1', 'u1', 'PASSWORD_RESET'),
    ).rejects.toThrow(/no email address/i);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('caps each user at 20 test emails a day, across restaurant windows', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z') });
    const { service, email } = makeService();
    let status = 0;
    for (let i = 0; i < 21 && !status; i++) {
      // Step past the 5-per-10-minutes restaurant window every 5 sends.
      if (i > 0 && i % 5 === 0) jest.advanceTimersByTime(11 * 60_000);
      try {
        await service.sendTest('r-cap', 'u-cap', 'RECEIPT');
      } catch (err) {
        status = err instanceof HttpException ? err.getStatus() : -1;
      }
    }
    expect(status).toBe(429);
    expect(email.send).toHaveBeenCalledTimes(20);
  });
});

describe('send-test request schema', () => {
  it('accepts no recipient from the client', () => {
    expect(emailTemplateTestSchema.safeParse({}).success).toBe(true);
    expect(
      emailTemplateTestSchema.safeParse({ to: 'victim@elsewhere.example' })
        .success,
    ).toBe(false);
  });
});

describe('EmailTemplatesController throttling', () => {
  it('rate-limits send-test per IP with @Throttle', () => {
    const handler = Object.getOwnPropertyDescriptor(
      EmailTemplatesController.prototype,
      'sendTest',
    )!.value as object;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(5);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});
