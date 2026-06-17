/**
 * Routes mounted under /api/projects. All routes require authentication.
 * Phase creation is nested here because it is scoped to a project.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { createProject, listProjects, getProject } from '../controllers/project.controller';
import { startPhase } from '../controllers/phase.controller';

export const projectRouter = Router();

projectRouter.use(requireAuth);

projectRouter.post('/', createProject);
projectRouter.get('/', listProjects);
projectRouter.get('/:id', getProject);
projectRouter.post('/:id/phases', startPhase);
