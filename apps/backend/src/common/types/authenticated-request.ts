import type { SessionUser } from '@nventra/types';
import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: SessionUser;
}
