/**
 * HTTP handlers for the phase-execution lifecycle. Phase creation is mounted
 * under a project (/api/projects/:id/phases); output submission and review act
 * on an execution id (/api/phases/:executionId/...).
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import * as phaseService from '../services/phase.service';

const startPhaseSchema = z.object({
  phaseType: z.enum(['PLANNER', 'DEV', 'QA', 'CODE_REVIEW', 'DOCS']),
  input: z
    .string()
    .max(env.inputMaxChars, `Input must be at most ${env.inputMaxChars} characters`)
    .optional(),
});

const submitOutputSchema = z.object({
  output: z.string().min(1, 'Output is required').max(env.inputMaxChars * 5),
});

const reviewSchema = z.object({
  action: z.enum(['APPROVE', 'REQUEST_CHANGES']),
  note: z.string().optional(),
});

/** POST /api/projects/:id/phases — start a new run of a phase. */
export async function startPhase(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { phaseType, input } = startPhaseSchema.parse(req.body);
    const execution = await phaseService.startPhase(
      req.params.id,
      phaseType,
      { id: req.user.id, role: req.user.role },
      input,
    );
    res.status(201).json(execution);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** POST /api/phases/:executionId/output — submit a run's output for review. */
export async function submitOutput(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { output } = submitOutputSchema.parse(req.body);
    const execution = await phaseService.submitPhaseOutput(req.params.executionId, output, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json(execution);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** POST /api/phases/:executionId/generate — generate this run's output via Claude. */
export async function generatePhase(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const execution = await phaseService.generatePhaseOutput(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json(execution);
  } catch (err) {
    next(err);
  }
}

/** POST /api/phases/:executionId/review — approve or request changes on a run. */
export async function reviewPhase(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { action, note } = reviewSchema.parse(req.body);
    const execution = await phaseService.reviewPhase(
      req.params.executionId,
      action,
      { id: req.user.id, role: req.user.role },
      note,
    );
    res.status(200).json(execution);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}
