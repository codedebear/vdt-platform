/**
 * Business logic for creating and reading projects, including resolution of the
 * project's next workflow phase via the pure workflow engine.
 */
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { getNextPhase, toExecutionSummaries, Track } from '../domain/workflow';

/** Fields accepted when creating a project. */
export interface CreateProjectInput {
  name: string;
  description?: string;
  track: Track;
}

/** Creates a new project owned by the given user. */
export async function createProject(ownerId: string, input: CreateProjectInput) {
  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description,
      track: input.track,
      ownerId,
    },
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
  const nextPhase = getNextPhase(
    project.track as Track,
    toExecutionSummaries(project.executions),
  );
  return { ...project, nextPhase };
}
