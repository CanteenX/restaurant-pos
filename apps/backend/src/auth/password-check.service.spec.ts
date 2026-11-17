import { HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import {
  PASSWORD_ATTEMPTS_PER_MINUTE,
  PASSWORD_MAX_FAILURES,
  PasswordCheckService,
} from './password-check.service';

// #236 review: every "confirm your current password" check gets a login-level
// limit: a per-user and per-IP rate, plus a failure lockout.

let hash = '';
beforeAll(async () => {
  hash = await bcrypt.hash('Right123!', 4);
});

function setup() {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new PasswordCheckService(audit as never);
  return { svc, audit };
}

const user = (id = 'u1') => ({ id, passwordHash: hash });

async function status(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof HttpException ? e.getStatus() : -1;
  }
}

describe('PasswordCheckService', () => {
  it('returns true for the right password and false for a wrong one', async () => {
    const { svc } = setup();
    await expect(svc.verify(user(), 'Right123!', '1.1.1.1')).resolves.toBe(
      true,
    );
    await expect(svc.verify(user(), 'Wrong123!', '1.1.1.1')).resolves.toBe(
      false,
    );
  });

  it('audits every failed attempt without the guessed value', async () => {
    const { svc, audit } = setup();
    await svc.verify(user(), 'Wrong123!', '1.1.1.1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'password.check_failed',
        entityId: 'u1',
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('Wrong123!');
  });

  it(`allows ${PASSWORD_ATTEMPTS_PER_MINUTE} attempts a minute per user, then answers 429`, async () => {
    const { svc } = setup();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_MINUTE; i++) {
      // A different address each time: the per-user limit still applies.
      await svc.verify(user(), 'Right123!', `10.0.0.${i}`);
    }
    expect(await status(svc.verify(user(), 'Right123!', '10.0.1.1'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    // Another user is not affected.
    expect(await status(svc.verify(user('u2'), 'Right123!', '10.0.1.1'))).toBe(
      'ok',
    );
  });

  it('limits attempts per address across different users', async () => {
    const { svc } = setup();
    for (let i = 0; i < PASSWORD_ATTEMPTS_PER_MINUTE; i++) {
      await svc.verify(user(`u${i}`), 'Right123!', '9.9.9.9');
    }
    expect(await status(svc.verify(user('ux'), 'Right123!', '9.9.9.9'))).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it(`locks the account for 15 minutes after ${PASSWORD_MAX_FAILURES} failures, even for the right password`, async () => {
    const { svc } = setup();
    const t0 = Date.now();
    const now = jest.spyOn(Date, 'now');
    try {
      // One failure a minute, so the per-minute rate never trips.
      for (let i = 0; i < PASSWORD_MAX_FAILURES; i++) {
        now.mockReturnValue(t0 + i * 61_000);
        await svc.verify(user(), 'Wrong123!', '8.8.8.8');
      }
      now.mockReturnValue(t0 + PASSWORD_MAX_FAILURES * 61_000);
      expect(await status(svc.verify(user(), 'Right123!', '8.8.8.8'))).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      now.mockReturnValue(t0 + (PASSWORD_MAX_FAILURES - 1) * 61_000 + 901_000);
      expect(await status(svc.verify(user(), 'Right123!', '8.8.8.8'))).toBe(
        'ok',
      );
    } finally {
      now.mockRestore();
    }
  });
});
