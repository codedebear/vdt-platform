/**
 * Rate limiting for the paid AI generation endpoint.
 *
 * Keyed by the authenticated user id (falling back to IP) so one user cannot
 * exhaust the shared API budget. In-memory store — sufficient for the current
 * single-container deployment; swap for a shared store (e.g. Redis) if the
 * backend is ever scaled to multiple instances.
 */
import rateLimit from 'express-rate-limit';
import { Request } from 'express';
import { env } from '../config/env';

export const generateRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.generateRateLimitPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anonymous',
  message: { error: 'Too many generation requests; please slow down and retry shortly' },
});

/**
 * Rate limiter for the attachment upload endpoint. Keyed by user id like the
 * generation limiter, because each upload persists bytes to Postgres and buffers
 * the file in memory — limiting it protects the shared storage/memory budget.
 */
export const attachmentRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.attachmentRateLimitPerMin,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anonymous',
  message: { error: 'Too many upload requests; please slow down and retry shortly' },
});
