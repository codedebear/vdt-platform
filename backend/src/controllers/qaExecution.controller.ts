/**
 * HTTP handlers for the staged QA execution flow (QAX-2A: scenario stage),
 * mounted under /api/phases/:executionId/qa/... . All routes require auth; the
 * service enforces QA-phase, worker-role, status and budget rules.
 */
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import * as qaService from '../services/qaExecution.service';

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
    const testRun = await qaService.generateScenarios(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json({ testRun });
  } catch (err) {
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
