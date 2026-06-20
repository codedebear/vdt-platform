/**
 * Business logic for creating and reading projects, including resolution of the
 * project's next workflow phase via the pure workflow engine.
 */
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import {
  getNextPhase,
  getStartablePhases,
  toExecutionSummaries,
  Track,
} from '../domain/workflow';
import { Role } from '../domain/permissions';
import { initialBudgetUsd } from '../domain/budget';

/** The authenticated user performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

/** Fields accepted when creating a project. */
export interface CreateProjectInput {
  name: string;
  description?: string;
  track: Track;
}

/** Creates a new project owned by the given user, seeded with the default budget. */
export async function createProject(ownerId: string, input: CreateProjectInput) {
  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      track: input.track,
      ownerId,
      budgetUsd: initialBudgetUsd(env.projectBudgetUsdDefault),
    },
  });
}

/**
 * Sets a project's lifetime AI budget (USD), or clears it (null = unlimited).
 * Only the project owner or a SUPER_ADMIN may change it.
 * @throws {AppError} 404 if the project is missing, 403 if the actor may not manage it.
 */
export async function updateProjectBudget(
  actor: Actor,
  projectId: string,
  budgetUsd: number | null,
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new AppError('Project not found', 404);
  }
  if (actor.role !== 'SUPER_ADMIN' && project.ownerId !== actor.id) {
    throw new AppError('Only the project owner or a super admin may change the budget', 403);
  }
  return prisma.project.update({
    where: { id: projectId },
    data: { budgetUsd },
  });
}

/** Lists all projects, newest first, with an execution count. */
export async function listProjects() {
  return prisma.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { executions: true } } },
  });
}

/**
 * Loads a project with its executions ordered chronologically.
 * @throws {AppError} 404 if no project with that id exists.
 */
export async function getProjectOrThrow(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      executions: {
        orderBy: { createdAt: 'asc' },
        // Attachment metadata only (never the `data` bytes) so the project
        // detail screen renders attachments without one request per run.
        include: {
          attachments: {
            select: {
              id: true,
              executionId: true,
              filename: true,
              mimeType: true,
              sizeBytes: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });
  if (!project) {
    throw new AppError('Project not found', 404);
  }
  return project;
}

/** Loads a project and annotates it with the next phase the engine suggests. */
export async function getProjectWithNextPhase(projectId: string) {
  const project = await getProjectOrThrow(projectId);
  const summaries = toExecutionSummaries(project.executions);
  const track = project.track as Track;
  const nextPhase = getNextPhase(track, summaries);
  // Computed server-side so the client never re-implements the start rules.
  const startablePhases = getStartablePhases(track, summaries);
  return { ...project, nextPhase, startablePhases };
}
