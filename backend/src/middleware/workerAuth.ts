/**
 * Authentication for the execution-worker API (QAX-3B). The worker presents a
 * shared bearer token (WORKER_TOKEN) — separate from user JWT auth — so a remote
 * worker process can claim jobs and submit results without a user account.
 *
 * Comparison is constant-time to avoid leaking the token via timing. If
 * WORKER_TOKEN is unset the worker endpoints are disabled (503).
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { AppError } from './errorHandler';

/** Extracts the presented token from `Authorization: Bearer` or `X-Worker-Token`. */
function presentedToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return req.header('x-worker-token')?.trim();
}

/** Constant-time string compare that is safe for differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Gate that requires a valid worker token. */
export function requireWorker(req: Request, _res: Response, next: NextFunction): void {
  if (!env.workerToken) {
    next(new AppError('The execution worker API is not configured (WORKER_TOKEN is missing)', 503));
    return;
  }
  const token = presentedToken(req);
  if (!token || !safeEqual(token, env.workerToken)) {
    next(new AppError('Invalid worker token', 401));
    return;
  }
  next();
}
