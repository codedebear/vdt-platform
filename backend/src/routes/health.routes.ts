/**
 * Liveness check used by Docker healthchecks and uptime monitors.
 */
import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
