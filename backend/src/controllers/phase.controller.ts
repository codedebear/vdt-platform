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

// Generation mode: 'sync' returns the output immediately (200); 'batch' submits
// to the Anthropic Batch API (~50% cheaper, async) and returns a QUEUED run (202)
// that the background poller later advances. Defaults to 'sync' (backward
// compatible — an empty body behaves exactly as before BE-BATCH-1).
const generateSchema = z.object({
  mode: z.enum(['sync', 'batch']).default('sync'),
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

/**
 * POST /api/phases/:executionId/generate — generate this run's output via Claude.
 * Body `{ mode }`: 'sync' (default) returns the output now (200); 'batch' queues
 * it on the Anthropic Batch API and returns the QUEUED run (202) for the poller.
 */
export async function generatePhase(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { mode } = generateSchema.parse(req.body ?? {});
    const actor = { id: req.user.id, role: req.user.role };
    if (mode === 'batch') {
      const execution = await phaseService.generatePhaseOutputBatch(req.params.executionId, actor);
      res.status(202).json(execution);
      return;
    }
    const execution = await phaseService.generatePhaseOutput(req.params.executionId, actor);
    res.status(200).json(execution);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
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


/**
 * GET /api/phases/:executionId — returns a single phase execution (metadata
 * only, no attachment bytes). Used by the UI to poll a run's status cheaply
 * (e.g. while a batch generation is QUEUED) instead of refetching the project.
 */
export async function getPhase(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const execution = await phaseService.getExecutionForView(req.params.executionId);
    res.status(200).json(execution);
  } catch (err) {
    next(err);
  }
}
