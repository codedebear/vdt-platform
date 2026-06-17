/**
 * Routes mounted under /api/phases that act on an existing phase execution.
 * All routes require authentication.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { generateRateLimiter } from '../middleware/rateLimit';
import { submitOutput, generatePhase, reviewPhase } from '../controllers/phase.controller';

export const phaseRouter = Router();

phaseRouter.use(requireAuth);

phaseRouter.post('/:executionId/output', submitOutput);
// Rate-limited (per user) because each call spends real API tokens; phase-type /
// worker-role authorization and the per-run cap are enforced in the service layer.
phaseRouter.post('/:executionId/generate', generateRateLimiter, generatePhase);
phaseRouter.post('/:executionId/review', reviewPhase);
