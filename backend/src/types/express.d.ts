import 'express';
import type { Role } from '../domain/permissions';

declare global {
  namespace Express {
    interface Request {
      /** The authenticated user attached by the `requireAuth` middleware. */
      user?: {
        id: string;
        email: string;
        role: Role;
      };
    }
  }
}

export {};
