/**
 * HTTP handlers for the staged QA execution flow (QAX-2A: scenario stage),
 * mounted under /api/phases/:executionId/qa/... . All routes require auth; the
 * service enforces QA-phase, worker-role, status and budget rules.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import { env } from '../config/env';
import * as qaService from '../services/qaExecution.service';

// Optional reviewer feedback steering a scenario regeneration; bounded to keep
// prompt cost in check. An empty body regenerates from the spec as before.
const generateScenariosSchema = z.object({
  feedback: z
    .string()
    .max(env.inputMaxChars, `Feedback must be at most ${env.inputMaxChars} characters`)
    .optional(),
});

/** GET /api/phases/:executionId/qa — fetch the QA run (scenarios + steps) or null. */
export async function getTestRun(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const testRun = await qaService.getTestRun(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json({ testRun });
  } catch (err) {
    next(err);
  }
}

/** POST /api/phases/:executionId/qa/scenarios/generate — AI-draft scenarios. */
export async function generateScenarios(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { feedback } = generateScenariosSchema.parse(req.body ?? {});
    const testRun = await qaService.generateScenarios(
      req.params.executionId,
      { id: req.user.id, role: req.user.role },
      feedback,
    );
    res.status(200).json({ testRun });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** POST /api/phases/:executionId/qa/scenarios/confirm — confirm scenarios → STEPS_DRAFT. */
export async function confirmScenarios(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const testRun = await qaService.confirmScenarios(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json({ testRun });
  } catch (err) {
    next(err);
  }
}
