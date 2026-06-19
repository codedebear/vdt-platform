/**
 * Routes mounted under /api/users for user administration. All routes require
 * authentication AND the USER_MANAGE permission (SUPER_ADMIN only); the role
 * gate is applied once to the whole router.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/authorize';
import { listUsers, getUser, updateUserRole } from '../controllers/user.controller';

export const userRouter = Router();

userRouter.use(requireAuth);
userRouter.use(requirePermission('USER_MANAGE'));

userRouter.get('/', listUsers);
userRouter.get('/:id', getUser);
userRouter.patch('/:id/role', updateUserRole);
