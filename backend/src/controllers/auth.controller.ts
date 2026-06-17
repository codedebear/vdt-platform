/**
 * HTTP handlers for the authentication endpoints.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prisma';
import { hashPassword, verifyPassword, generateToken } from '../services/auth.service';
import { AppError } from '../middleware/errorHandler';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Registers a new user account.
 * Note: this endpoint is intentionally open in this phase (no admin gate yet)
 * since user-management UI has not been built. Tracked as a follow-up risk.
 */
export async function register(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password, name } = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new AppError('Email is already registered', 409);
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, name },
    });

    const token = generateToken({ sub: user.id, email: user.email, role: user.role });

    res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/**
 * Authenticates a user with email + password and returns a signed JWT.
 */
export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      throw new AppError('Invalid email or password', 401);
    }

    const token = generateToken({ sub: user.id, email: user.email, role: user.role });

    res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}
