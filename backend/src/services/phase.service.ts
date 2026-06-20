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
import { env } from '../config/env';
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
import { buildPrompt, PriorOutput } from '../domain/prompts';
import { estimateCostUsd } from '../domain/pricing';
import { isBudgetExhausted } from '../domain/budget';
import { generateText, GenerationClient } from './generation.service';
import { prepareAttachments } from './attachmentContent.service';

/** Truncates a string to at most `max` characters, marking where it was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

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

/**
 * Generates this run's output with the Claude API instead of receiving it
 * manually, then moves the run to AWAITING_REVIEW. The prompt is built from the
 * project context plus the approved outputs of earlier phases. Permitted for the
 * phase's worker role while the run is IN_PROGRESS or CHANGES_REQUESTED.
 * @param client - Optional injected generation client (used by tests).
 * @throws {AppError} 404 if missing, 403 if the role may not produce this phase,
 *   409 on an invalid status, 502/503 on generation failure.
 */
export async function generatePhaseOutput(
  executionId: string,
  actor: Actor,
  client?: GenerationClient,
) {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    include: {
      attachments: {
        select: { filename: true, mimeType: true, data: true },
        orderBy: { createdAt: 'asc' },
      },
      project: {
        include: {
          executions: {
            where: { status: 'APPROVED', output: { not: null } },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }

  const phaseType = execution.phaseType as PhaseType;
  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType })) {
    throw new AppError(`Your role is not allowed to produce a ${phaseType} phase`, 403);
  }

  if (execution.status !== 'IN_PROGRESS' && execution.status !== 'CHANGES_REQUESTED') {
    throw new AppError(
      `Generation is only allowed while a run is IN_PROGRESS or CHANGES_REQUESTED (current: ${execution.status})`,
      409,
    );
  }

  // Cost guard (hard block): refuse if the project's accumulated AI spend has
  // reached its budget. Checked before the paid Claude call so no tokens are
  // spent once exhausted.
  if (isBudgetExhausted(execution.project.spentUsd, execution.project.budgetUsd)) {
    throw new AppError(
      `This project has reached its AI budget ($${execution.project.budgetUsd?.toFixed(2)}); ask an admin to raise it`,
      402,
    );
  }

  // Cost guard: cap how many times a single run may be (re)generated. Claim a
  // slot atomically (conditional increment) so concurrent regenerates cannot
  // both pass a stale read and exceed the cap.
  const claim = await prisma.phaseExecution.updateMany({
    where: {
      id: executionId,
      status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] },
      generationCount: { lt: env.generateMaxPerRun },
    },
    data: { generationCount: { increment: 1 } },
  });
  if (claim.count === 0) {
    throw new AppError(
      `This run has reached its generation limit (${env.generateMaxPerRun}); submit or have it reviewed instead`,
      429,
    );
  }

  const priorOutputs: PriorOutput[] = execution.project.executions.map((e) => ({
    phaseType: e.phaseType as PhaseType,
    // Cap each prior output folded into the prompt to bound token cost.
    output: truncate(e.output as string, env.priorOutputMaxChars),
  }));

  const { system, user } = buildPrompt({
    projectName: execution.project.name,
    description: execution.project.description ?? undefined,
    track: execution.project.track as Track,
    phaseType,
    priorOutputs,
    input: execution.input ? truncate(execution.input, env.inputMaxChars) : undefined,
  });

  let result;
  try {
    // Fold in any attachments: PDFs become document blocks Claude reads directly;
    // spreadsheets/Word/text are extracted and appended to the prompt.
    const prepared = await prepareAttachments(
      execution.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        data: Buffer.from(a.data),
      })),
    );
    const userPrompt =
      prepared.textSections.length > 0
        ? `${user}\n\n## Attached documents\n${prepared.textSections.join('\n\n')}`
        : user;

    result = await generateText(system, userPrompt, client, prepared.documents);
  } catch (err) {
    // The generation (or attachment prep) failed, so release the slot we claimed
    // — a failed attempt should not count against the per-run regeneration cap.
    await prisma.phaseExecution
      .updateMany({
        where: { id: executionId, generationCount: { gt: 0 } },
        data: { generationCount: { decrement: 1 } },
      })
      .catch(() => undefined);
    throw err;
  }

  // Record the output and bill the project's budget. Both updates run in one
  // transaction so the run and the project's accumulated spend stay consistent.
  const costUsd = estimateCostUsd(env.anthropicModel, result.inputTokens, result.outputTokens, {
    inputPerMTok: env.anthropicPriceInputPerMTok,
    outputPerMTok: env.anthropicPriceOutputPerMTok,
  });
  const [updated] = await prisma.$transaction([
    prisma.phaseExecution.update({
      where: { id: executionId },
      data: {
        output: result.text,
        status: 'AWAITING_REVIEW',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
      },
    }),
    prisma.project.update({
      where: { id: execution.project.id },
      data: { spentUsd: { increment: costUsd } },
    }),
  ]);
  return updated;
}
