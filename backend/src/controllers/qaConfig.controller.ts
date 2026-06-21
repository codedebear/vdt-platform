/**
 * HTTP handlers for project-level QA execution configuration (QAX-3A): the target
 * environment and the encrypted secrets vault. Mounted under /api/projects/:id.
 * Authorization (owner or SUPER_ADMIN) is enforced in the service layer.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as qaConfig from '../services/qaConfig.service';

const setTargetSchema = z.object({
  label: z.string().max(200).optional(),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  hostAllowlist: z.array(z.string().min(1)).default([]),
  isNonProd: z.boolean().default(true),
});

const setSecretSchema = z.object({
  name: z.string().min(1).max(100),
  value: z.string().min(1).max(10000),
});

function actorOf(req: Request): { id: string; role: qaConfig.Actor['role'] } {
  return { id: req.user!.id, role: req.user!.role };
}

/** GET /api/projects/:id/target — the project's target environment or null. */
export async function getTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const target = await qaConfig.getTarget(req.params.id, actorOf(req));
    res.status(200).json({ target });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/projects/:id/target — create or replace the target environment. */
export async function setTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const input = setTargetSchema.parse(req.body);
    const target = await qaConfig.setTarget(req.params.id, actorOf(req), input);
    res.status(200).json({ target });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** GET /api/projects/:id/secrets — the project's secret names (never values). */
export async function listSecrets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const names = await qaConfig.listSecretNames(req.params.id, actorOf(req));
    res.status(200).json({ names });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/projects/:id/secrets — create or update a secret (value encrypted). */
export async function setSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    const { name, value } = setSecretSchema.parse(req.body);
    const result = await qaConfig.setSecret(req.params.id, actorOf(req), name, value);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** DELETE /api/projects/:id/secrets/:name — remove a secret. */
export async function deleteSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) throw new AppError('Unauthorized', 401);
    await qaConfig.deleteSecret(req.params.id, actorOf(req), req.params.name);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
