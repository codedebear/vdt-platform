/**
 * Routes mounted under /api/phases that act on an existing phase execution.
 * All routes require authentication.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { generateRateLimiter, attachmentRateLimiter } from '../middleware/rateLimit';
import { attachmentUpload } from '../middleware/upload';
import {
  submitOutput,
  generatePhase,
  reviewPhase,
  getPhase,
} from '../controllers/phase.controller';
import {
  uploadAttachments,
  listAttachments,
  deleteAttachment,
} from '../controllers/attachment.controller';
import {
  getTestRun,
  generateScenarios,
  confirmScenarios,
  generateSteps,
  confirmSteps,
  recompileArtifacts,
  reviseStage,
} from '../controllers/qaExecution.controller';

export const phaseRouter = Router();

phaseRouter.use(requireAuth);

// Lightweight single-run read for status polling (e.g. a QUEUED batch run).
phaseRouter.get('/:executionId', getPhase);

phaseRouter.post('/:executionId/output', submitOutput);
// Rate-limited (per user) because each call spends real API tokens; phase-type /
// worker-role authorization and the per-run cap are enforced in the service layer.
phaseRouter.post('/:executionId/generate', generateRateLimiter, generatePhase);
phaseRouter.post('/:executionId/review', reviewPhase);

// Attachments (context documents the AI reads when generating this run).
// `attachmentUpload` parses multipart + enforces per-file size / accepted types;
// per-run count/size limits and worker-role authorization live in the service.
phaseRouter.post(
  '/:executionId/attachments',
  attachmentRateLimiter,
  attachmentUpload,
  uploadAttachments,
);
phaseRouter.get('/:executionId/attachments', listAttachments);
phaseRouter.delete('/:executionId/attachments/:attachmentId', deleteAttachment);

// Staged QA execution flow (QAX-2). Scenario generation spends API tokens, so it
// is rate-limited per user; QA-phase / worker-role / status / budget rules live
// in the service layer.
phaseRouter.get('/:executionId/qa', getTestRun);
phaseRouter.post('/:executionId/qa/scenarios/generate', generateRateLimiter, generateScenarios);
phaseRouter.post('/:executionId/qa/scenarios/confirm', confirmScenarios);
phaseRouter.post('/:executionId/qa/steps/generate', generateRateLimiter, generateSteps);
phaseRouter.post('/:executionId/qa/steps/confirm', generateRateLimiter, confirmSteps);
phaseRouter.post('/:executionId/qa/artifacts/recompile', generateRateLimiter, recompileArtifacts);
phaseRouter.post('/:executionId/qa/revise', reviseStage);
