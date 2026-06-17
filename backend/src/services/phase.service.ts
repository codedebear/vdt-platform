/**
 * Business logic for the phase-execution lifecycle: starting a run, submitting
 * its output for review, and applying a human review decision.
 *
 * Workflow sequencing rules are delegated to the pure engine in
 * ../domain/workflow; authorization (which role may act) is delegated to the
 * pure engine in ../domain/permissions. Every entry point takes the acting user
 * (`actor`) so it can enforce role- and ownership-based access.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import {
  canStartPhase,
  nextRunNumber,
  resolveReview,
  toExecutionSummaries,
  PhaseStatus,
  PhaseType,
  ReviewAction,
  Track,
} from '../domain/workflow';
import { can, Role } from '../domain/permissions';

/** The authenticated user performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

/**
 * Starts a new run of `phaseType` for a project after validating both
 * authorization and workflow rules. Creates a PhaseExecution in IN_PROGRESS
 * with the next run number. The read-check-create sequence runs inside a
 * transaction, and a concurrent run-number collision (unique constraint) is
 * translated to a 409 rather than surfacing as a 500.
 * @throws {AppError} 403 if the role may not run this phase, 404 if the project
 *   is missing, 409 if the phase cannot start or a concurrent run was created.
 */
export async function startPhase(
  projectId: string,
  phaseType: PhaseType,
  actor: Actor,
  input?: string,
) {
  if (!can(actor.role, 'PHASE_START', { phaseType })) {
    throw new AppError(`Your role is not allowed to run a ${phaseType} phase`, 403);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: projectId },
        include: { executions: { orderBy: { createdAt: 'asc' } } },
      });
      if (!project) {
        throw new AppError('Project not found', 404);
      }

      const summaries = toExecutionSummaries(project.executions);
      const decision = canStartPhase(project.track as Track, phaseType, summaries);
      if (!decision.allowed) {
        throw new AppError(decision.reason ?? 'Phase cannot be started', 409);
      }

      return tx.phaseExecution.create({
        data: {
          projectId,
          phaseType,
          runNumber: nextRunNumber(summaries, phaseType),
          status: 'IN_PROGRESS',
          input,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(
        'A concurrent run of this phase was just created; please retry',
        409,
      );
    }
    throw err;
  }
}

/**
 * Records the output of a phase run and moves it to AWAITING_REVIEW. Permitted
 * while the run is IN_PROGRESS or CHANGES_REQUESTED (resubmission after feedback)
 * and only for the role that runs the phase's type.
 * @throws {AppError} 404 if the execution is missing, 403 if the role may not
 *   submit this phase, 409 on an invalid status.
 */
export async function submitPhaseOutput(executionId: string, output: string, actor: Actor) {
  const execution = await prisma.phaseExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType: execution.phaseType as PhaseType })) {
    throw new AppError(
      `Your role is not allowed to submit a ${execution.phaseType} phase`,
      403,
    );
  }

  if (execution.status !== 'IN_PROGRESS' && execution.status !== 'CHANGES_REQUESTED') {
    throw new AppError(
      `Output can only be submitted while a run is IN_PROGRESS or CHANGES_REQUESTED (current: ${execution.status})`,
      409,
    );
  }

  return prisma.phaseExecution.update({
    where: { id: executionId },
    data: { output, status: 'AWAITING_REVIEW' },
  });
}

/**
 * Applies a human review decision to a phase run. Only the owner of the run's
 * project (or a SUPER_ADMIN) may review. APPROVE marks it APPROVED and stamps
 * completedAt; REQUEST_CHANGES marks it CHANGES_REQUESTED.
 * @throws {AppError} 404 if the execution is missing, 403 if the actor may not
 *   review this project, 409 if it is not awaiting review.
 */
export async function reviewPhase(
  executionId: string,
  action: ReviewAction,
  actor: Actor,
  note?: string,
) {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    include: { project: { select: { ownerId: true } } },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  const isProjectOwner = execution.project.ownerId === actor.id;
  if (!can(actor.role, 'PHASE_REVIEW', { isProjectOwner })) {
    throw new AppError('Only the project owner or a super admin may review this phase', 403);
  }

  let nextStatus: PhaseStatus;
  try {
    nextStatus = resolveReview(execution.status as PhaseStatus, action);
  } catch (err) {
    throw new AppError((err as Error).message, 409);
  }

  return prisma.phaseExecution.update({
    where: { id: executionId },
    data: {
      status: nextStatus,
      reviewNote: note,
      completedAt: nextStatus === 'APPROVED' ? new Date() : null,
    },
  });
}
