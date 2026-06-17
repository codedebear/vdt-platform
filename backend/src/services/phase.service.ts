/**
 * Business logic for the phase-execution lifecycle: starting a run, submitting
 * its output for review, and applying a human review decision. All workflow
 * rules are delegated to the pure engine in ../domain/workflow.
 */
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { getProjectOrThrow } from './project.service';
import {
  canStartPhase,
  nextRunNumber,
  resolveReview,
  ExecutionSummary,
  PhaseStatus,
  PhaseType,
  ReviewAction,
  Track,
} from '../domain/workflow';

function toSummaries(
  executions: { phaseType: string; status: string; runNumber: number }[],
): ExecutionSummary[] {
  return executions.map((e) => ({
    phaseType: e.phaseType as PhaseType,
    status: e.status as PhaseStatus,
    runNumber: e.runNumber,
  }));
}

/**
 * Starts a new run of `phaseType` for a project after validating workflow
 * rules. Creates a PhaseExecution in IN_PROGRESS with the next run number.
 * @throws {AppError} 404 if the project is missing, 409 if the phase cannot start.
 */
export async function startPhase(
  projectId: string,
  phaseType: PhaseType,
  input?: string,
) {
  const project = await getProjectOrThrow(projectId);
  const summaries = toSummaries(project.executions);

  const decision = canStartPhase(project.track as Track, phaseType, summaries);
  if (!decision.allowed) {
    throw new AppError(decision.reason ?? 'Phase cannot be started', 409);
  }

  return prisma.phaseExecution.create({
    data: {
      projectId,
      phaseType,
      runNumber: nextRunNumber(summaries, phaseType),
      status: 'IN_PROGRESS',
      input,
    },
  });
}

/**
 * Records the output of a phase run and moves it to AWAITING_REVIEW. Permitted
 * while the run is IN_PROGRESS or CHANGES_REQUESTED (resubmission after feedback).
 * @throws {AppError} 404 if the execution is missing, 409 on an invalid status.
 */
export async function submitPhaseOutput(executionId: string, output: string) {
  const execution = await prisma.phaseExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
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
 * Applies a human review decision to a phase run. APPROVE marks it APPROVED and
 * stamps completedAt; REQUEST_CHANGES marks it CHANGES_REQUESTED.
 * @throws {AppError} 404 if the execution is missing, 409 if it is not awaiting review.
 */
export async function reviewPhase(
  executionId: string,
  action: ReviewAction,
  note?: string,
) {
  const execution = await prisma.phaseExecution.findUnique({ where: { id: executionId } });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
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
