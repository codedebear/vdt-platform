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
