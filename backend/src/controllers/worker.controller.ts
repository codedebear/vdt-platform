/**
 * HTTP handlers for the execution-worker API (QAX-3B), mounted under /api/worker
 * behind the worker-token gate. The worker claims a job, heartbeats while running,
 * and submits per-step results.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as worker from '../services/worker.service';

const workerIdSchema = z.object({ workerId: z.string().min(1).max(200) });

const resultSchema = z.object({
  stepId: z.string().min(1),
  status: z.enum(['PASS', 'FAIL', 'SKIPPED']),
  actualResult: z.string().max(20000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  evidence: z.string().optional(), // base64; size-checked in the service
  evidenceMime: z.string().max(200).optional(),
  remark: z.string().max(2000).optional(),
});

const submitSchema = z.object({
  workerId: z.string().min(1).max(200),
  results: z.array(resultSchema).min(1, 'at least one result is required'),
});

/** POST /api/worker/jobs/claim — claim the next EXECUTING run (204 if none). */
export async function claimJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workerId } = workerIdSchema.parse(req.body ?? {});
    const job = await worker.claimJob(workerId);
    if (!job) {
      res.status(204).send();
      return;
    }
    res.status(200).json({ job });
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** POST /api/worker/jobs/:runId/heartbeat — renew the lease while executing. */
export async function heartbeat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workerId } = workerIdSchema.parse(req.body ?? {});
    const out = await worker.heartbeat(req.params.runId, workerId);
    res.status(200).json(out);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** POST /api/worker/jobs/:runId/results — submit step results (finalizes when done). */
export async function submitResults(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { workerId, results } = submitSchema.parse(req.body ?? {});
    const outcome = await worker.submitResults(req.params.runId, workerId, results);
    res.status(200).json(outcome);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}
