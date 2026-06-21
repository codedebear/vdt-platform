/**
 * Execution-worker job queue (QAX-3B). A remote worker (QAX-3C, on the Windows
 * laptop) claims an EXECUTING run, runs each step's compiled artifact against the
 * project's non-prod target, and submits per-step results. When every step has a
 * terminal result the run is rolled up and advanced to RESULTS_REVIEW.
 *
 * The queue is Neon-backed (no extra infra): a claim is an atomic conditional
 * updateMany that sets a time-boxed lease, so two workers can't run the same run
 * and an abandoned lease is reclaimable. Authorization is the worker token
 * (middleware/workerAuth); there is no per-user check here.
 */
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import {
  advanceStage,
  rollUpScenario,
  rollUpRun,
  ScenarioResult,
  TestStatus,
} from '../domain/qaExecution';
import { getDecryptedSecrets } from './qaConfig.service';

/** Cap on inline evidence (screenshot/response) per step, to protect Neon storage. */
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

/** One step handed to the worker to execute. */
export interface ClaimedStep {
  stepId: string;
  scenarioNo: number;
  order: number;
  stepName: string;
  expectedResult: string;
  artifactType: string | null;
  artifactSpec: unknown;
}

/** A claimed job: everything the worker needs to run the run's steps. */
export interface ClaimedJob {
  runId: string;
  executionId: string;
  baseUrl: string;
  hostAllowlist: string[];
  /** Decrypted secrets to resolve `${VAR}` placeholders. Sensitive — TLS only. */
  secrets: Record<string, string>;
  steps: ClaimedStep[];
  leaseExpiresAt: Date;
}

/**
 * Atomically claims the next EXECUTING run with no active lease and returns its
 * job payload, or null if there is nothing to run. The claim is a guarded
 * updateMany, so a race between workers leaves only one winner.
 * @throws {AppError} 409 if the claimed run has no target configured.
 */
export async function claimJob(workerId: string): Promise<ClaimedJob | null> {
  const now = new Date();
  const free = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] };

  const candidate = await prisma.testRun.findFirst({
    where: { stage: 'EXECUTING', ...free },
    orderBy: { startedAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) {
    return null;
  }

  const leaseExpiresAt = new Date(now.getTime() + env.workerLeaseMs);
  const claim = await prisma.testRun.updateMany({
    where: { id: candidate.id, stage: 'EXECUTING', ...free },
    data: { claimedAt: now, claimedBy: workerId, leaseExpiresAt },
  });
  if (claim.count === 0) {
    // Lost the race to another worker; the caller may simply poll again.
    return null;
  }

  const run = await prisma.testRun.findUnique({
    where: { id: candidate.id },
    include: {
      execution: { select: { id: true, projectId: true } },
      scenarios: { orderBy: { no: 'asc' }, include: { steps: { orderBy: { order: 'asc' } } } },
    },
  });
  if (!run) {
    return null;
  }

  const target = await prisma.targetEnvironment.findUnique({
    where: { projectId: run.execution.projectId },
  });
  if (!target) {
    // Misconfigured between start and claim: release the lease and report.
    await prisma.testRun.updateMany({
      where: { id: run.id },
      data: { claimedBy: null, leaseExpiresAt: null, claimedAt: null },
    });
    throw new AppError('The run has no target environment configured', 409);
  }

  const secrets = await getDecryptedSecrets(run.execution.projectId);
  const steps: ClaimedStep[] = run.scenarios.flatMap((s) =>
    s.steps
      .filter((st) => st.artifactSpec != null)
      .map((st) => ({
        stepId: st.id,
        scenarioNo: s.no,
        order: st.order,
        stepName: st.stepName,
        expectedResult: st.expectedResult,
        artifactType: st.artifactType,
        artifactSpec: st.artifactSpec,
      })),
  );

  return {
    runId: run.id,
    executionId: run.execution.id,
    baseUrl: target.baseUrl,
    hostAllowlist: target.hostAllowlist,
    secrets,
    steps,
    leaseExpiresAt,
  };
}

/**
 * Renews the lease on a run the worker still holds, so a long execution is not
 * reclaimed mid-flight.
 * @throws {AppError} 409 if the run is not EXECUTING or not held by this worker.
 */
export async function heartbeat(runId: string, workerId: string): Promise<{ leaseExpiresAt: Date }> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + env.workerLeaseMs);
  const renewed = await prisma.testRun.updateMany({
    where: { id: runId, stage: 'EXECUTING', claimedBy: workerId },
    data: { leaseExpiresAt },
  });
  if (renewed.count === 0) {
    throw new AppError('This run is not currently held by this worker', 409);
  }
  return { leaseExpiresAt };
}

/** One step's outcome submitted by the worker. */
export interface SubmittedResult {
  stepId: string;
  status: Extract<TestStatus, 'PASS' | 'FAIL'>;
  actualResult?: string;
  durationMs?: number;
  evidence?: string; // base64
  evidenceMime?: string;
  remark?: string;
}

/** Outcome of a submit: whether the run finalized, and its current state. */
export interface SubmitOutcome {
  runId: string;
  finalized: boolean;
  stage: string;
  overallResult: ScenarioResult | null;
}

/**
 * Records per-step results for a run the worker holds, then finalizes the run if
 * every step now has a terminal result: rolls up each scenario and the run, and
 * advances EXECUTING → RESULTS_REVIEW (releasing the lease).
 * @throws {AppError} 404 if the run is missing, 409 if not EXECUTING / not held by
 *   this worker, 422 on an unknown step or oversized evidence.
 */
export async function submitResults(
  runId: string,
  workerId: string,
  results: SubmittedResult[],
): Promise<SubmitOutcome> {
  const run = await prisma.testRun.findUnique({
    where: { id: runId },
    include: { scenarios: { include: { steps: { include: { result: true } } } } },
  });
  if (!run) {
    throw new AppError('Run not found', 404);
  }
  if (run.stage !== 'EXECUTING') {
    throw new AppError(`Results can only be submitted while the run is EXECUTING (current: ${run.stage})`, 409);
  }
  if (run.claimedBy !== workerId) {
    throw new AppError('This run is not currently held by this worker', 409);
  }

  const stepIds = new Set(run.scenarios.flatMap((s) => s.steps.map((st) => st.id)));
  for (const r of results) {
    if (!stepIds.has(r.stepId)) {
      throw new AppError(`Unknown step ${r.stepId} for this run`, 422);
    }
    if (r.evidence && Buffer.byteLength(r.evidence, 'base64') > MAX_EVIDENCE_BYTES) {
      throw new AppError('Evidence exceeds the 2MB per-step limit', 422);
    }
  }

  const now = new Date();
  await prisma.$transaction(
    results.map((r) =>
      prisma.testResult.update({
        where: { stepId: r.stepId },
        data: {
          status: r.status,
          actualResult: r.actualResult,
          durationMs: r.durationMs,
          evidence: r.evidence ? Buffer.from(r.evidence, 'base64') : undefined,
          evidenceMime: r.evidenceMime,
          remark: r.remark,
          executedAt: now,
        },
      }),
    ),
  );

  // Re-read statuses to decide whether the whole run is done.
  const scenarios = await prisma.testScenario.findMany({
    where: { runId },
    include: { steps: { include: { result: { select: { status: true } } } } },
  });
  const allStatuses: TestStatus[] = scenarios.flatMap((s) =>
    s.steps.map((st) => (st.result?.status as TestStatus) ?? 'NOT_START'),
  );
  const finalized = allStatuses.length > 0 && allStatuses.every((s) => s === 'PASS' || s === 'FAIL');

  if (!finalized) {
    return { runId, finalized: false, stage: run.stage, overallResult: run.overallResult };
  }

  // Roll each scenario up, then the whole run, and advance to RESULTS_REVIEW.
  const scenarioResults: ScenarioResult[] = [];
  const scenarioUpdates = scenarios.map((s) => {
    const statuses = s.steps.map((st) => (st.result?.status as TestStatus) ?? 'NOT_START');
    const result = rollUpScenario(statuses);
    scenarioResults.push(result);
    return prisma.testScenario.update({ where: { id: s.id }, data: { result } });
  });
  const overallResult = rollUpRun(scenarioResults);

  await prisma.$transaction([
    ...scenarioUpdates,
    prisma.testRun.updateMany({
      where: { id: runId, stage: 'EXECUTING', claimedBy: workerId },
      data: {
        stage: advanceStage('EXECUTING', 'EXECUTION_COMPLETE'),
        overallResult,
        finishedAt: now,
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
      },
    }),
  ]);

  return { runId, finalized: true, stage: 'RESULTS_REVIEW', overallResult };
}
