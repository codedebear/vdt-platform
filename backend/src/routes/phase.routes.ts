/**
 * Routes mounted under /api/phases that act on an existing phase execution.
 * All routes require authentication.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { submitOutput, reviewPhase } from '../controllers/phase.controller';

export const phaseRouter = Router();

phaseRouter.use(requireAuth);

phaseRouter.post('/:executionId/output', submitOutput);
phaseRouter.post('/:executionId/review', reviewPhase);
