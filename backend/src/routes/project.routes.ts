/**
 * Routes mounted under /api/projects. All routes require authentication.
 * Phase creation is nested here because it is scoped to a project.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/authorize';
import { createProject, listProjects, getProject } from '../controllers/project.controller';
import { startPhase } from '../controllers/phase.controller';

export const projectRouter = Router();

projectRouter.use(requireAuth);

projectRouter.post('/', requirePermission('PROJECT_CREATE'), createProject);
projectRouter.get('/', listProjects);
projectRouter.get('/:id', getProject);
// Phase start is authorized per phase-type inside the service layer.
projectRouter.post('/:id/phases', startPhase);
