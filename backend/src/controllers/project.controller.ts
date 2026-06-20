/**
 * HTTP handlers for project resources mounted under /api/projects.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler';
import * as projectService from '../services/project.service';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  description: z.string().optional(),
  track: z.enum(['FULL_SDLC', 'QA_ONLY']),
});

const updateBudgetSchema = z.object({
  // null clears the budget (unlimited); a number is the lifetime USD cap.
  budgetUsd: z.number().nonnegative('Budget must be zero or positive').nullable(),
});

/** POST /api/projects — create a project owned by the authenticated user. */
export async function createProject(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const data = createProjectSchema.parse(req.body);
    const project = await projectService.createProject(req.user.id, data);
    res.status(201).json(project);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}

/** GET /api/projects — list all projects. */
export async function listProjects(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const projects = await projectService.listProjects();
    res.status(200).json(projects);
  } catch (err) {
    next(err);
  }
}

/** GET /api/projects/:id — fetch one project with executions and next phase. */
export async function getProject(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const project = await projectService.getProjectWithNextPhase(req.params.id);
    res.status(200).json(project);
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/projects/:id/budget — set or clear the project's AI cost budget. */
export async function updateProjectBudget(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }
    const { budgetUsd } = updateBudgetSchema.parse(req.body);
    const project = await projectService.updateProjectBudget(
      { id: req.user.id, role: req.user.role },
      req.params.id,
      budgetUsd,
    );
    res.status(200).json(project);
  } catch (err) {
    if (err instanceof z.ZodError) {
      next(new AppError(err.errors.map((e) => e.message).join(', '), 422));
      return;
    }
    next(err);
  }
}
