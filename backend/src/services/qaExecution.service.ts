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
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { can, Role } from '../domain/permissions';
import { PhaseType } from '../domain/workflow';
import { QaStage, advanceStage, reviseStage as reviseStageRule } from '../domain/qaExecution';
import {
  buildScenarioPrompt,
  buildStepPrompt,
  buildCompilePrompt,
  StepScenarioContext,
  CompileScenarioContext,
} from '../domain/qaPrompts';
import {
  parseScenarioDrafts,
  parseScenarioStepsDrafts,
  parseCompiledArtifacts,
  QaParseError,
} from '../domain/qaParsing';
import { estimateCostUsd } from '../domain/pricing';
import { isBudgetExhausted } from '../domain/budget';
import { generateText, GenerationClient, DocumentBlock } from './generation.service';
import { prepareAttachments } from './attachmentContent.service';
import { buildUatrWorkbook, UatrWorkbook } from './uatrWorkbook';
import { UatrRunInput } from '../domain/uatrExport';

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
        include: {
          steps: {
            orderBy: { order: 'asc' },
            // Exclude the `evidence` bytes here — they can be large (screenshots)
            // and are fetched lazily via GET .../qa/steps/:stepId/evidence. Keep
            // evidenceMime so the UI knows evidence exists and its kind.
            include: {
              result: {
                select: {
                  id: true,
                  stepId: true,
                  status: true,
                  actualResult: true,
                  evidenceMime: true,
                  durationMs: true,
                  executedAt: true,
                  remark: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

/**
 * Returns the stored evidence (a BROWSER step's screenshot, or an HTTP step's
 * captured request/response text) for one step's result, to stream to the client.
 * Verifies the step belongs to the given execution's run before returning, so a
 * stepId from another run cannot be read through this execution. 404 if the step,
 * its result, or the evidence is missing. Read-only; the route requires auth (the
 * same gate as getTestRun) — there is no per-step authorization beyond that.
 */
export async function getStepEvidence(
  executionId: string,
  stepId: string,
  _actor: Actor,
): Promise<{ evidence: Buffer; evidenceMime: string }> {
  const step = await prisma.testStep.findFirst({
    where: { id: stepId, scenario: { run: { executionId } } },
    select: { result: { select: { evidence: true, evidenceMime: true } } },
  });
  if (!step) {
    throw new AppError('Step not found', 404);
  }
  if (!step.result || !step.result.evidence) {
    throw new AppError('No evidence stored for this step', 404);
  }
  return {
    evidence: Buffer.from(step.result.evidence),
    evidenceMime: step.result.evidenceMime ?? 'application/octet-stream',
  };
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
 * Generates (or regenerates) the test steps for every confirmed scenario with
 * Claude, and stores them as TestStep rows. Only allowed while the run is at the
 * STEPS_DRAFT stage; regenerating replaces the previous draft steps.
 *
 * When `feedback` is supplied and steps already exist, the call is a guided
 * revision: the current steps plus the feedback are fed back to Claude so it
 * refines them (the review → regenerate → review loop), instead of starting over.
 * @param feedback - Optional reviewer feedback steering a regeneration.
 * @param client - Optional injected generation client (used by tests).
 * @throws {AppError} 404/403/409 per guards, 402 over budget, 502/503 on
 *   generation failure or unparseable output.
 */
export async function generateSteps(
  executionId: string,
  actor: Actor,
  feedback?: string,
  client?: GenerationClient,
) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  if (stage !== 'STEPS_DRAFT') {
    throw new AppError(
      `Steps can only be generated at the STEPS_DRAFT stage (current: ${stage})`,
      409,
    );
  }

  if (isBudgetExhausted(execution.project.spentUsd, execution.project.budgetUsd)) {
    throw new AppError(
      `This project has reached its AI budget ($${execution.project.budgetUsd?.toFixed(2)}); ask an admin to raise it`,
      402,
    );
  }

  const runId = execution.testRun.id;
  // Load the confirmed scenarios with their current steps (steps are only fed
  // back to the model for a feedback-steered revision).
  const scenarios = await prisma.testScenario.findMany({
    where: { runId },
    orderBy: { no: 'asc' },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  if (scenarios.length === 0) {
    throw new AppError('There are no confirmed scenarios to write steps for', 409);
  }

  const trimmedFeedback = feedback?.trim();
  const scenarioContexts: StepScenarioContext[] = scenarios.map((s) => ({
    no: s.no,
    topic: s.topic,
    testName: s.testName,
    ...(s.system ? { system: s.system } : {}),
    ...(trimmedFeedback && s.steps.length > 0
      ? { steps: s.steps.map((st) => ({ stepName: st.stepName, expectedResult: st.expectedResult })) }
      : {}),
  }));

  const { system, user } = buildStepPrompt({
    projectName: execution.project.name,
    description: execution.project.description ?? undefined,
    input: execution.input ? truncate(execution.input, env.inputMaxChars) : undefined,
    scenarios: scenarioContexts,
    feedback: trimmedFeedback ? truncate(trimmedFeedback, env.inputMaxChars) : undefined,
  });

  const result = await generateText(system, user, client);

  let groups;
  try {
    groups = parseScenarioStepsDrafts(result.text);
  } catch (err) {
    if (err instanceof QaParseError) {
      throw new AppError(`AI returned steps that could not be parsed: ${err.message}`, 502);
    }
    throw err;
  }

  // Map each returned group back to a scenario by its `no`; ignore unknown numbers.
  const scenarioByNo = new Map(scenarios.map((s) => [s.no, s.id]));
  const newSteps = groups.flatMap((g) => {
    const scenarioId = scenarioByNo.get(g.no);
    if (!scenarioId) return [];
    return g.steps.map((st, i) => ({
      scenarioId,
      order: i + 1,
      stepName: st.stepName,
      expectedResult: st.expectedResult,
    }));
  });
  if (newSteps.length === 0) {
    throw new AppError('AI returned no steps matching the existing scenarios', 502);
  }

  const actualCostUsd = estimateCostUsd(
    env.anthropicModel,
    result.inputTokens,
    result.outputTokens,
    priceOverrideFromEnv(),
  );

  const scenarioIds = scenarios.map((s) => s.id);
  const projectId = execution.project.id;
  await prisma.$transaction(async (tx) => {
    // Regeneration replaces all current steps for this run's scenarios.
    await tx.testStep.deleteMany({ where: { scenarioId: { in: scenarioIds } } });
    await tx.testStep.createMany({ data: newSteps });
    await tx.project.update({
      where: { id: projectId },
      data: { spentUsd: { increment: actualCostUsd } },
    });
  });

  return getTestRun(executionId, actor);
}

/**
 * Compiles every step of a run into an executable artifactSpec with Claude and
 * stores `artifactType` + `artifactSpec` on each matched TestStep. Shared by
 * {@link confirmSteps} (first compile) and {@link recompileArtifacts} (feedback
 * loop). When `feedback` is given, current artifacts are fed back so the model
 * refines them. Returns nothing; throws on failure.
 * @throws {AppError} 409 no scenarios/steps, 502 on unparseable/empty compile.
 */
async function compileRunArtifacts(
  execution: { id: string; testRun: { id: string } | null; input: string | null; project: { id: string; name: string; description: string | null } },
  feedback: string | undefined,
  client?: GenerationClient,
): Promise<void> {
  const runId = execution.testRun!.id;
  const scenarios = await prisma.testScenario.findMany({
    where: { runId },
    orderBy: { no: 'asc' },
    include: { steps: { orderBy: { order: 'asc' } } },
  });
  const totalSteps = scenarios.reduce((n, s) => n + s.steps.length, 0);
  if (totalSteps === 0) {
    throw new AppError('There are no steps to compile', 409);
  }

  const trimmedFeedback = feedback?.trim();
  const scenarioContexts: CompileScenarioContext[] = scenarios.map((s) => ({
    no: s.no,
    testName: s.testName,
    ...(s.system ? { system: s.system } : {}),
    steps: s.steps.map((st) => ({
      no: s.no,
      order: st.order,
      stepName: st.stepName,
      expectedResult: st.expectedResult,
      ...(trimmedFeedback && st.artifactSpec != null ? { artifact: st.artifactSpec } : {}),
    })),
  }));

  const { system, user } = buildCompilePrompt({
    projectName: execution.project.name,
    description: execution.project.description ?? undefined,
    input: execution.input ? truncate(execution.input, env.inputMaxChars) : undefined,
    scenarios: scenarioContexts,
    feedback: trimmedFeedback ? truncate(trimmedFeedback, env.inputMaxChars) : undefined,
  });

  const result = await generateText(system, user, client);

  let compiled;
  try {
    compiled = parseCompiledArtifacts(result.text);
  } catch (err) {
    if (err instanceof QaParseError) {
      throw new AppError(`AI returned artifacts that could not be parsed: ${err.message}`, 502);
    }
    throw err;
  }

  // Map each compiled artifact back to a step by (scenario no, step order).
  const stepByKey = new Map<string, string>();
  for (const s of scenarios) {
    for (const st of s.steps) {
      stepByKey.set(`${s.no}:${st.order}`, st.id);
    }
  }
  const updates = compiled.flatMap((c) => {
    const stepId = stepByKey.get(`${c.no}:${c.order}`);
    if (!stepId) return [];
    return [{ stepId, kind: c.artifact.kind, spec: c.artifact as Prisma.InputJsonValue }];
  });
  if (updates.length === 0) {
    throw new AppError('AI returned no artifacts matching the existing steps', 502);
  }

  const actualCostUsd = estimateCostUsd(
    env.anthropicModel,
    result.inputTokens,
    result.outputTokens,
    priceOverrideFromEnv(),
  );

  await prisma.$transaction([
    ...updates.map((u) =>
      prisma.testStep.update({
        where: { id: u.stepId },
        data: { artifactType: u.kind, artifactSpec: u.spec },
      }),
    ),
    prisma.project.update({
      where: { id: execution.project.id },
      data: { spentUsd: { increment: actualCostUsd } },
    }),
  ]);
}

/**
 * Confirms the drafted steps and compiles them: runs the compile call, stores an
 * artifactSpec on each step, and advances the run from STEPS_DRAFT to COMPILED.
 * @param client - Optional injected generation client (used by tests).
 * @throws {AppError} 404/403/409 per guards, 402 over budget, 502/503 on compile.
 */
export async function confirmSteps(executionId: string, actor: Actor, client?: GenerationClient) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  if (stage !== 'STEPS_DRAFT') {
    throw new AppError(
      `Steps can only be confirmed/compiled at the STEPS_DRAFT stage (current: ${stage})`,
      409,
    );
  }
  if (isBudgetExhausted(execution.project.spentUsd, execution.project.budgetUsd)) {
    throw new AppError(
      `This project has reached its AI budget ($${execution.project.budgetUsd?.toFixed(2)}); ask an admin to raise it`,
      402,
    );
  }

  await compileRunArtifacts(execution, undefined, client);
  await prisma.testRun.update({
    where: { id: execution.testRun.id },
    data: { stage: advanceStage(stage, 'CONFIRM_STEPS') },
  });
  return getTestRun(executionId, actor);
}

/**
 * Recompiles the artifacts of an already-COMPILED run, optionally steered by
 * reviewer `feedback` (the review → regenerate → review loop at the compile
 * stage). The run stays at COMPILED.
 * @param client - Optional injected generation client (used by tests).
 * @throws {AppError} 404/403/409 per guards, 402 over budget, 502/503 on compile.
 */
export async function recompileArtifacts(
  executionId: string,
  actor: Actor,
  feedback?: string,
  client?: GenerationClient,
) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  if (stage !== 'COMPILED') {
    throw new AppError(`Artifacts can only be recompiled at the COMPILED stage (current: ${stage})`, 409);
  }
  if (isBudgetExhausted(execution.project.spentUsd, execution.project.budgetUsd)) {
    throw new AppError(
      `This project has reached its AI budget ($${execution.project.budgetUsd?.toFixed(2)}); ask an admin to raise it`,
      402,
    );
  }

  await compileRunArtifacts(execution, feedback, client);
  return getTestRun(executionId, actor);
}

/**
 * Starts execution of a compiled run: validates the project has a non-prod target
 * environment and that every step is compiled, resets per-step results to
 * NOT_START, stamps the run's start time, and advances COMPILED → EXECUTING. The
 * execution worker (QAX-3B/3C) then claims and runs it.
 * @throws {AppError} 404/403 per guards, 409 if not COMPILED / no target / a step
 *   is uncompiled / there are no steps.
 */
export async function startRun(executionId: string, actor: Actor) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  if (stage !== 'COMPILED') {
    throw new AppError(`A run can only be started from the COMPILED stage (current: ${stage})`, 409);
  }

  const target = await prisma.targetEnvironment.findUnique({
    where: { projectId: execution.project.id },
  });
  if (!target) {
    throw new AppError('Configure a non-production target environment before running', 409);
  }
  if (!target.isNonProd) {
    throw new AppError('The target environment is not marked non-production; refusing to run', 409);
  }

  const scenarios = await prisma.testScenario.findMany({
    where: { runId: execution.testRun.id },
    include: { steps: { select: { id: true, artifactSpec: true } } },
  });
  const steps = scenarios.flatMap((s) => s.steps);
  if (steps.length === 0) {
    throw new AppError('There are no steps to run', 409);
  }
  if (steps.some((st) => st.artifactSpec == null)) {
    throw new AppError('Some steps are not compiled; recompile before running', 409);
  }

  const stepIds = steps.map((st) => st.id);
  await prisma.$transaction([
    // Reset any previous results, then queue a NOT_START result per step.
    prisma.testResult.deleteMany({ where: { stepId: { in: stepIds } } }),
    prisma.testResult.createMany({
      data: stepIds.map((stepId) => ({ stepId, status: 'NOT_START' as const })),
    }),
    prisma.testRun.update({
      where: { id: execution.testRun.id },
      data: { stage: advanceStage(stage, 'START_RUN'), startedAt: new Date(), finishedAt: null },
    }),
  ]);
  return getTestRun(executionId, actor);
}

/**
 * Moves a run back to an earlier stage (a "request changes" within the QA flow,
 * e.g. COMPILED → STEPS_DRAFT to revise steps). The target must be strictly
 * earlier; downstream drafts are replaced when regenerated at the target stage.
 * @throws {AppError} 404/403/409 per guards (409 if the target is not earlier).
 */
export async function reviseStage(executionId: string, actor: Actor, target: QaStage) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  let nextStage: QaStage;
  try {
    nextStage = reviseStageRule(stage, target);
  } catch (err) {
    throw new AppError((err as Error).message, 409);
  }
  await prisma.testRun.update({
    where: { id: execution.testRun.id },
    data: { stage: nextStage },
  });
  return getTestRun(executionId, actor);
}

/** Optional UATR Amendment metadata stamped on the run at results sign-off. */
export interface UatrSignOff {
  version?: string;
  preparedBy?: string;
  reviewedBy?: string;
  approvedBy?: string;
}

/**
 * Confirms the reviewed results and advances the run from RESULTS_REVIEW to
 * EXPORTED (the formal sign-off; EXPORTED is terminal). Optionally stamps the
 * UATR Amendment metadata (version / prepared / reviewed / approved by). Spends
 * **0 tokens** — no Claude call. The actual `.xlsx` is produced on demand by
 * {@link exportUatr}.
 * @throws {AppError} 404/403/409 per guards (409 if not at RESULTS_REVIEW).
 */
export async function confirmResults(executionId: string, actor: Actor, signOff?: UatrSignOff) {
  const execution = await loadWritableQaExecution(executionId, actor);
  if (!execution.testRun) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = execution.testRun.stage as QaStage;
  if (stage !== 'RESULTS_REVIEW') {
    throw new AppError(
      `Results can only be confirmed at the RESULTS_REVIEW stage (current: ${stage})`,
      409,
    );
  }

  let nextStage: QaStage;
  try {
    nextStage = advanceStage(stage, 'CONFIRM_RESULTS');
  } catch (err) {
    throw new AppError((err as Error).message, 409);
  }

  const trimmed = (v: string | undefined) => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  await prisma.testRun.update({
    where: { id: execution.testRun.id },
    data: {
      stage: nextStage,
      ...(trimmed(signOff?.version) ? { version: trimmed(signOff?.version) } : {}),
      ...(signOff && 'preparedBy' in signOff ? { preparedBy: trimmed(signOff.preparedBy) ?? null } : {}),
      ...(signOff && 'reviewedBy' in signOff ? { reviewedBy: trimmed(signOff.reviewedBy) ?? null } : {}),
      ...(signOff && 'approvedBy' in signOff ? { approvedBy: trimmed(signOff.approvedBy) ?? null } : {}),
    },
  });
  return getTestRun(executionId, actor);
}

/**
 * Builds the UATR `.xlsx` workbook for a run on demand from its stored scenarios,
 * steps and results. Allowed at RESULTS_REVIEW (preview before sign-off) and
 * EXPORTED (the signed-off report); the run's results are immutable once
 * EXPORTED, so the bytes are stable across regenerations. Read-only, no Claude.
 * @throws {AppError} 404 missing, 409 not a QA phase / run not yet at a stage
 *   with results, 403 role.
 */
export async function exportUatr(executionId: string, actor: Actor): Promise<UatrWorkbook> {
  const execution = await prisma.phaseExecution.findUnique({
    where: { id: executionId },
    include: {
      project: { select: { name: true } },
      testRun: {
        include: {
          scenarios: {
            orderBy: { no: 'asc' },
            include: { steps: { orderBy: { order: 'asc' }, include: { result: true } } },
          },
        },
      },
    },
  });
  if (!execution) {
    throw new AppError('Phase execution not found', 404);
  }
  if ((execution.phaseType as PhaseType) !== 'QA') {
    throw new AppError('This is not a QA phase execution', 409);
  }
  if (!can(actor.role, 'PHASE_SUBMIT', { phaseType: 'QA' })) {
    throw new AppError('Your role is not allowed to access this QA report', 403);
  }
  const run = execution.testRun;
  if (!run) {
    throw new AppError('No QA run has been started for this phase yet', 409);
  }
  const stage = run.stage as QaStage;
  if (stage !== 'RESULTS_REVIEW' && stage !== 'EXPORTED') {
    throw new AppError(
      `The UATR report is available once the run reaches RESULTS_REVIEW (current: ${stage})`,
      409,
    );
  }

  const runInput: UatrRunInput = {
    projectName: execution.project.name,
    version: run.version,
    preparedBy: run.preparedBy,
    reviewedBy: run.reviewedBy,
    approvedBy: run.approvedBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    overallResult: run.overallResult,
    generatedAt: new Date(),
    scenarios: run.scenarios.map((s) => ({
      no: s.no,
      topic: s.topic,
      testName: s.testName,
      system: s.system,
      remark: s.remark,
      result: s.result,
      steps: s.steps.map((st) => ({
        order: st.order,
        stepName: st.stepName,
        expectedResult: st.expectedResult,
        status: st.result?.status ?? 'NOT_START',
        remark: st.result?.remark,
        executedAt: st.result?.executedAt,
      })),
    })),
  };

  return buildUatrWorkbook(runInput);
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
