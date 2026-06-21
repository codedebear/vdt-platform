/**
 * Routes for the execution-worker API (QAX-3B), mounted under /api/worker. All
 * routes require a valid worker token (not user auth).
 */
import { Router } from 'express';
import { requireWorker } from '../middleware/workerAuth';
import { claimJob, heartbeat, submitResults } from '../controllers/worker.controller';

export const workerRouter = Router();

workerRouter.use(requireWorker);

workerRouter.post('/jobs/claim', claimJob);
workerRouter.post('/jobs/:runId/heartbeat', heartbeat);
workerRouter.post('/jobs/:runId/results', submitResults);
