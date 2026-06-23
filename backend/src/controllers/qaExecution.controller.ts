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

// Optional reviewer feedback steering a regeneration; bounded to keep prompt cost
// in check. An empty body regenerates from the spec/scenarios as before. Shared by
// the scenario and step generate endpoints.
const feedbackSchema = z.object({
  feedback: z
    .string()
    .max(env.inputMaxChars, `Feedback must be at most ${env.inputMaxChars} characters`)
    .optional(),
});

// Target stage for a back-navigation ("request changes" within the QA flow).
const reviseSchema = z.object({
  targetStage: z.enum(['SCENARIO_DRAFT', 'STEPS_DRAFT', 'COMPILED', 'EXECUTING', 'RESULTS_REVIEW']),
});

// Optional UATR Amendment metadata stamped at results sign-off. All fields
// optional; bounded to keep cell values sane. An empty body just signs off.
const signOffSchema = z.object({
  version: z.string().trim().min(1).max(40).optional(),
  preparedBy: z.string().trim().max(120).optional(),
  reviewedBy: z.string().trim().max(120).optional(),
  approvedBy: z.string().trim().max(120).optional(),
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

/**
 * GET /api/phases/:executionId/qa/steps/:stepId/evidence — stream one step's
 * stored evidence (a BROWSER screenshot or an HTTP capture) inline, with its
 * stored MIME type. 404 if the step (within this run) has no evidence.
 */
export async function getStepEvidence(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { evidence, evidenceMime } = await qaService.getStepEvidence(
      req.params.executionId,
      req.params.stepId,
      { id: req.user.id, role: req.user.role },
    );
    res.setHeader('Content-Type', evidenceMime);
    res.setHeader('Content-Disposition', 'inline');
    // Evidence may contain sensitive response data — never cache it in shared caches.
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(evidence);
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
    const { feedback } = feedbackSchema.parse(req.body ?? {});
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

/** POST /api/phases/:executionId/qa/steps/generate — AI-draft steps for the
 * confirmed scenarios (optional `feedback` steers a regeneration). */
export async function generateSteps(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { feedback } = feedbackSchema.parse(req.body ?? {});
    const testRun = await qaService.generateSteps(
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

/** POST /api/phases/:executionId/qa/steps/confirm — compile steps → COMPILED. */
export async function confirmSteps(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const testRun = await qaService.confirmSteps(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json({ testRun });
  } catch (err) {
    next(err);
  }
}

/** POST /api/phases/:executionId/qa/artifacts/recompile — recompile artifacts
 * (optional `feedback` steers the revision); stays at COMPILED. */
export async function recompileArtifacts(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { feedback } = feedbackSchema.parse(req.body ?? {});
    const testRun = await qaService.recompileArtifacts(
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

/** POST /api/phases/:executionId/qa/run/start — start executing the compiled run. */
export async function startRun(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const testRun = await qaService.startRun(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.status(200).json({ testRun });
  } catch (err) {
    next(err);
  }
}

/** POST /api/phases/:executionId/qa/revise — move back to an earlier stage. */
export async function reviseStage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { targetStage } = reviseSchema.parse(req.body);
    const testRun = await qaService.reviseStage(
      req.params.executionId,
      { id: req.user.id, role: req.user.role },
      targetStage,
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

/** POST /api/phases/:executionId/qa/results/confirm — sign off results → EXPORTED. */
export async function confirmResults(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const signOff = signOffSchema.parse(req.body ?? {});
    const testRun = await qaService.confirmResults(
      req.params.executionId,
      { id: req.user.id, role: req.user.role },
      signOff,
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

/** GET /api/phases/:executionId/qa/export — download the UATR .xlsx (on demand). */
export async function exportUatr(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { filename, buffer } = await qaService.exportUatr(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/phases/:executionId/qa/report.pdf — stream the UATR PDF "Test Result
 * Report" (full UATR info + per-step evidence) for review & sign-off.
 */
export async function exportUatrPdf(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { filename, buffer } = await qaService.exportUatrPdf(req.params.executionId, {
      id: req.user.id,
      role: req.user.role,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
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
