/**
 * HTTP handlers for user administration, mounted under /api/users. Every route
 * is gated by the USER_MANAGE permission (SUPER_ADMIN) in the router; these
 * handlers validate input and delegate to the user service.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as userService from '../services/user.service';

const updateRoleSchema = z.object({
  role: z.enum(['SUPER_ADMIN', 'PROJECT_OWNER', 'BA', 'SA', 'QA', 'OPERATION']),
});

/** GET /api/users — list all users. */
export async function listUsers(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const users = await userService.listUsers();
    res.status(200).json(users);
  } catch (err) {
    next(err);
  }
}

/** GET /api/users/:id — fetch a single user. */
export async function getUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await userService.getUser(req.params.id);
    res.status(200).json(user);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/users/:id/role — change a user's global role. */
export async function updateUserRole(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { role } = updateRoleSchema.parse(req.body);
    const user = await userService.updateUserRole(req.user.id, req.params.id, role);
    res.status(200).json(user);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}
