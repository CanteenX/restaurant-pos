import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

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
