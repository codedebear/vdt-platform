/**
 * Authorization middleware. Gates a route on a role-only permission using the
 * pure engine in ../domain/permissions. Must run after `requireAuth` so that
 * `req.user` is populated.
 *
 * Only role-only actions (PROJECT_CREATE, USER_MANAGE, PROJECT_VIEW) are gated
 * here. Actions whose decision depends on runtime context — the target phase
 * type or project ownership — are enforced inside the service layer where that
 * context is available.
 */
import { NextFunction, Request, Response } from 'express';
import { Action, can } from '../domain/permissions';
import { AppError } from './errorHandler';

/**
 * Returns middleware that allows the request only if the authenticated user's
 * role satisfies `action`.
 * @param action - The role-only action to authorize.
 * @throws {AppError} 401 if unauthenticated, 403 if the role is not permitted.
 */
export function requirePermission(action: Action) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError('Unauthorized', 401));
      return;
    }
    if (!can(req.user.role, action)) {
      next(new AppError('You do not have permission to perform this action', 403));
      return;
    }
    next();
  };
}
