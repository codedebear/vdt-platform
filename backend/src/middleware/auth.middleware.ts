/**
 * Middleware that enforces a valid JWT bearer token on protected routes.
 */
import { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { AppError } from './errorHandler';

/**
 * Verifies the `Authorization: Bearer <token>` header and attaches the
 * decoded user to `req.user`. Calls `next` with an `AppError(401)` if the
 * token is missing, malformed, or invalid.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError('Missing or malformed Authorization header', 401));
    return;
  }

  const token = header.slice('Bearer '.length);

  try {
    const decoded = verifyToken(token);
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}
