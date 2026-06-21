/**
 * Routes mounted under /api/projects. All routes require authentication.
 * Phase creation is nested here because it is scoped to a project.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/authorize';
import {
  createProject,
  listProjects,
  getProject,
  updateProjectBudget,
} from '../controllers/project.controller';
import { startPhase } from '../controllers/phase.controller';
import {
  getTarget,
  setTarget,
  listSecrets,
  setSecret,
  deleteSecret,
} from '../controllers/qaConfig.controller';

export const projectRouter = Router();

projectRouter.use(requireAuth);

projectRouter.post('/', requirePermission('PROJECT_CREATE'), createProject);
projectRouter.get('/', listProjects);
projectRouter.get('/:id', getProject);
// Budget changes are authorized (owner or SUPER_ADMIN) inside the service layer.
projectRouter.patch('/:id/budget', updateProjectBudget);
// Phase start is authorized per phase-type inside the service layer.
projectRouter.post('/:id/phases', startPhase);

// QA execution config (QAX-3A): non-prod target + encrypted secrets vault.
// Owner/SUPER_ADMIN authorization is enforced in the service layer.
projectRouter.get('/:id/target', getTarget);
projectRouter.put('/:id/target', setTarget);
projectRouter.get('/:id/secrets', listSecrets);
projectRouter.put('/:id/secrets', setSecret);
projectRouter.delete('/:id/secrets/:name', deleteSecret);
