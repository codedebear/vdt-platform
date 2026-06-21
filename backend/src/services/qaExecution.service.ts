/**
 * Business logic for the staged QA execution flow (QAX-2A: scenario stage).
 *
 * A QA `PhaseExecution` gains a `TestRun` whose stage machine (domain/qaExecution)
 * drives: draft scenarios → confirm → draft steps → compile → execute → review →
 * export. This module implements the first leg — AI-generating test scenarios from
 * the run's spec/attachments and confirming them — reusing the existing
 * generation client (services/generation.service) and pricing/budget domain.
 *
 * Workflow/stage rules live in the pure domain modules; authorization is delegated
 * to domain/permissions. QA generation cost is accounted post-hoc against the
 * project budget (a cheap pre-check rejects an already-exhausted budget, and the
 * actual cost is added after the call). Unlike the single-shot phase generation,
 * this flow is human-gated step by step with low concurrency, so it does not need
 * the Serializable reserve/settle slot machinery; it can adopt it later if needed.
 */
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { can, Role } from '../domain/permissions';
import { PhaseType } from '../domain/workflow';
import { QaStage, advanceStage } from '../domain/qaExecution';
import { buildScenarioPrompt } from '../domain/qaPrompts';
import { parseScenarioDrafts, QaParseError } from '../domain/qaParsing';
import { estimateCostUsd } from '../domain/pricing';
import { isBudgetExhausted } from '../domain/budget';
import { generateText, GenerationClient, DocumentBlock } from './generation.service';
import { prepareAttachments } from './attachmentContent.service';

/** The authenticated user performing an action. */
export interface Actor {
  id: string;
  role: Role;
}

/** Truncates a string to at most `max` characters, marking where it was cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** The per-million-token price override assembled from env (0 = use the table). */
function priceOverrideFromEnv() {
  return {
    inputPerMTok: env.anthropicPriceInputPerMTok,
    outputPerMTok: env.anthropicPriceOutputPerMTok,
  };
}

/**
 * Loads a QA phase execution (with its project and attachments) and enforces the
 * guards shared by every QA-flow write: the execution exists, it is a QA phase,
 * the actor's role may produce QA output, and the run is in a writable status.
 * Returns the loaded execution for the caller to apply stage-specific rules.
 * @throws {AppError} 404 missing, 409 not a QA phase / bad status, 403 role.
 */
async function loadWritableQaExecution(executionId: string, actor: Actor) {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    include: {
      testRun: true,
      attachments: {
        select: { filename: true, mimeType: true, data: true },
        orderBy: { createdAt: 'asc' },
      },
      project: { select: { id: true, name: true, description: true, spentUsd: true, budgetUsd: true } },
    },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }
  if ((execution.phaseType as PhaseType) !== 'QA') {
    throw new AppError('This is not a QA phase execution', 409);
  }
  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType: 'QA' })) {
    throw new AppError('Your role is not allowed to run a QA phase', 403);
  }
  if (execution.status !== 'IN_PROGRESS' && execution.status !== 'CHANGES_REQUESTED') {
    throw new AppError(
      `The QA flow can only run while the phase is IN_PROGRESS or CHANGES_REQUESTED (current: ${execution.status})`,
      409,
    );
  }
  return execution;
}

/** Fetches a run's TestRun with scenarios (and their steps), ordered for display
 * and for the UATR export. Returns null when no QA run has been started yet. */
export async function getTestRun(executionId: string, _actor: Actor) {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    select: { id: true, phaseType: true },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }
  return prisma.testRun.findUnique({
    where: { executionId },
    include: {
      scenarios: {
        orderBy: { no: 'asc' },
        include: { steps: { orderBy: { order: 'asc' } } },
      },
    },
  });
}

/**
 * Generates (or regenerates) the test scenarios for a QA run with Claude, from
 * the run's input plus any attached documents, and stores them as TestScenario
 * rows. Creates the TestRun on first use. Only allowed while the run is at the
 * SCENARIO_DRAFT stage; regenerating replaces the previous draft scenarios.
 *
 * When `feedback` is supplied and the run already has draft scenarios, the call
 * is a guided revision: the current scenarios plus the feedback are fed back to
 * Claude so it refines the list (the review → regenerate → review loop) instead
 * of drafting from scratch.
 * @param feedback - Optional reviewer feedback steering a regeneration.
 * @param client - Optional injected generation client (used by tests).
 * @throws {AppError} 404/403/409 per guards, 402 over budget, 502/503 on
 *   generation failure or unparseable output.
 */
export async function generateScenarios(
  executionId: string,
  actor: Actor,
  feedback?: string,
  client?: GenerationClient,
) {
  const execution = await loadWritableQaExecution(executionId, actor);
  const stage = (execution.testRun?.stage ?? 'SCENARIO_DRAFT') as QaStage;
  if (stage !== 'SCENARIO_DRAFT') {
    throw new AppError(
      `Scenarios can only be generated at the SCENARIO_DRAFT stage (current: ${stage})`,
      409,
    );
  }

  // Cheap early reject when the budget is already spent (avoids building a prompt
  // and an API call). Actual cost is added after the call below.
  if (isBudgetExhausted(execution.project.spentUsd, execution.project.budgetUsd)) {
    throw new AppError(
      `This project has reached its AI budget ($${execution.project.budgetUsd?.toFixed(2)}); ask an admin to raise it`,
      402,
    );
  }

  // For a feedback-steered regeneration, load the current draft scenarios so the
  // model revises them rather than starting over.
  const trimmedFeedback = feedback?.trim();
  const currentScenarios =
    trimmedFeedback && execution.testRun
      ? (
          await prisma.testScenario.findMany({
            where: { runId: execution.testRun.id },
            orderBy: { no: 'asc' },
            select: { topic: true, testName: true, system: true, remark: true },
          })
        ).map((s) => ({
          topic: s.topic,
          testName: s.testName,
          ...(s.system ? { system: s.system } : {}),
          ...(s.remark ? { remark: s.remark } : {}),
        }))
      : undefined;

  const { system, user } = buildScenarioPrompt({
    projectName: execution.project.name,
    description: execution.project.description ?? undefined,
    input: execution.input ? truncate(execution.input, env.inputMaxChars) : undefined,
    feedback: trimmedFeedback ? truncate(trimmedFeedback, env.inputMaxChars) : undefined,
    currentScenarios,
  });

  // Fold attachments in: PDFs as document blocks Claude reads directly, other
  // types extracted to text. A bad file (422) here costs nothing.
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

  const result = await generateText(
    system,
    userPrompt,
    client,
    prepared.documents as DocumentBlock[],
  );

  let drafts;
  try {
    drafts = parseScenarioDrafts(result.text);
  } catch (err) {
    if (err instanceof QaParseError) {
      throw new AppError(`AI returned scenarios that could not be parsed: ${err.message}`, 502);
    }
    throw err;
  }

  const actualCostUsd = estimateCostUsd(
    env.anthropicModel,
    result.inputTokens,
    result.outputTokens,
    priceOverrideFromEnv(),
  );

  const projectId = execution.project.id;
  await prisma.$transaction(async (tx) => {
    // Ensure the TestRun exists (created at SCENARIO_DRAFT on first generation).
    const run = await tx.testRun.upsert({
      where: { executionId },
      create: { executionId },
      update: {},
    });
    // Regeneration replaces the previous (unconfirmed) draft scenarios.
    await tx.testScenario.deleteMany({ where: { runId: run.id } });
    await tx.testScenario.createMany({
      data: drafts.map((d, i) => ({
        runId: run.id,
        no: i + 1,
        topic: d.topic,
        testName: d.testName,
        system: d.system,
        remark: d.remark,
      })),
    });
    await tx.project.update({
      where: { id: projectId },
      data: { spentUsd: { increment: actualCostUsd } },
    });
  });

  return getTestRun(executionId, actor);
}

/**
 * Confirms the drafted scenarios and advances the run from SCENARIO_DRAFT to
 * STEPS_DRAFT. Requires at least one scenario.
 * @throws {AppError} 404/403/409 per guards.
 */
export async function confirmScenarios(executionId: string, actor: Actor) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;

  const scenarioCount = await prisma.testScenario.count({
    where: { runId: execution.testRun.id },
  });
  if (scenarioCount === 0) {
    throw new AppError('Generate at least one scenario before confirming', 409);
  }

  let nextStage: QaStage;
  try {
    nextStage = advanceStage(stage, 'CONFIRM_SCENARIOS');
  } catch (err) {
    throw new AppError((err as Error).message, 409);
  }

  await prisma.testRun.update({
    where: { id: execution.testRun.id },
    data: { stage: nextStage },
  });
  return getTestRun(executionId, actor);
}
