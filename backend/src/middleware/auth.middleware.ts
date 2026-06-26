/**
 * Middleware that enforces a valid JWT bearer token on protected routes.
 */
import { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { AppError } from './errorHandler';
import { prisma } from '../config/prisma';
import type { Role } from '../domain/permissions';

/**
 * Verifies the `Authorization: Bearer <token>` header, then fetches the
 * user's *current* role from the database so that role changes made by an
 * admin take effect immediately without waiting for the token to expire.
 * Attaches the result to `req.user`. Calls `next` with an `AppError(401)`
 * if the token is missing/invalid or the user no longer exists.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    next(new AppError('Missing or malformed Authorization header', 401));
    return;
  }

  const token = header.slice('Bearer '.length);

  try {
    const decoded = verifyToken(token);
    // Fetch fresh role from DB — token role may be stale after an admin role change.
    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { role: true },
    });
    if (!dbUser) {
      next(new AppError('User not found', 401));
      return;
    }
    req.user = { id: decoded.sub, email: decoded.email, role: dbUser.role as Role };
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}
