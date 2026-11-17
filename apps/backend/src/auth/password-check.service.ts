import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service';
import { FailureLockout } from './failure-lockout';

// "Confirm your current password" checks (#236 review): changing your own
// password, deleting your own account, turning 2FA off. Without a limit, a
// borrowed session could guess the password at the global request rate and
// then lock the real owner out. Each check is limited like login (5 a minute)
// per account AND per client address, and repeated failures lock the account
// (and, at a higher count, the address) for 15 minutes, like the PIN lockout.
export const PASSWORD_ATTEMPTS_PER_MINUTE = 5;
export const PASSWORD_MAX_FAILURES = 5;
export const PASSWORD_IP_MAX_FAILURES = 20;
const MINUTE_MS = 60_000;
const LOCK_MS = 15 * MINUTE_MS;

export interface PasswordHolder {
  id: string;
  passwordHash: string;
}

@Injectable()
export class PasswordCheckService {
  // FailureLockout as a rate limit: every attempt counts, and the key is
  // held for a minute once it reaches the limit.
  private readonly userRate = new FailureLockout(
    PASSWORD_ATTEMPTS_PER_MINUTE,
    MINUTE_MS,
  );
  private readonly ipRate = new FailureLockout(
    PASSWORD_ATTEMPTS_PER_MINUTE,
    MINUTE_MS,
  );
  private readonly userFailures = new FailureLockout(
    PASSWORD_MAX_FAILURES,
    LOCK_MS,
  );
  private readonly ipFailures = new FailureLockout(
    PASSWORD_IP_MAX_FAILURES,
    LOCK_MS,
  );

  constructor(private readonly audit: AuditService) {}

  /**
   * True when `password` is the user's current password, false when not.
   * Throws 429 while the account or the address is rate-limited or locked;
   * the password is not even compared then.
   */
  async verify(
    user: PasswordHolder,
    password: string,
    ip = 'unknown',
  ): Promise<boolean> {
    const wait = Math.max(
      this.userRate.lockedFor(user.id),
      this.ipRate.lockedFor(ip),
      this.userFailures.lockedFor(user.id),
      this.ipFailures.lockedFor(ip),
    );
    if (wait > 0) {
      throw new HttpException(
        `Too many password attempts. Try again in ${wait} seconds.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.userRate.fail(user.id);
    this.ipRate.fail(ip);

    if (await bcrypt.compare(password, user.passwordHash)) {
      this.userFailures.reset(user.id);
      return true;
    }
    this.userFailures.fail(user.id);
    this.ipFailures.fail(ip);
    // Never the guessed value: only who, from where.
    await this.audit.record({
      userId: user.id,
      action: 'password.check_failed',
      entity: 'User',
      entityId: user.id,
      metadata: { ip },
    });
    return false;
  }
}
