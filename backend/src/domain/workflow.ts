/**
 * Pure workflow engine for VDT Platform projects.
 *
 * Defines the ordered phase sequence for each project track and the rules that
 * govern when a phase run may start and how a review action transitions a phase
 * execution's status. This module has no database / Prisma dependency so it can
 * be unit-tested in isolation and reused freely by the service layer.
 *
 * The string-literal unions below intentionally mirror the Prisma enums of the
 * same name (Track, PhaseType, PhaseStatus). Prisma generates those enums with
 * identical string values, so the two are interchangeable at runtime.
 */

export type Track = 'FULL_SDLC' | 'QA_ONLY';

export type PhaseType = 'PLANNER' | 'DEV' | 'QA' | 'CODE_REVIEW' | 'DOCS';

export type PhaseStatus =
  | 'IN_PROGRESS'
  | 'AWAITING_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'FAILED';

export type ReviewAction = 'APPROVE' | 'REQUEST_CHANGES';

/** Ordered phases that make up each track. */
export const PHASE_SEQUENCE: Record<Track, readonly PhaseType[]> = {
  FULL_SDLC: ['PLANNER', 'DEV', 'QA', 'CODE_REVIEW', 'DOCS'],
  QA_ONLY: ['PLANNER', 'QA'],
};

/**
 * Phases that may be run repeatedly (a fresh execution per run) even after a
 * previous run was approved — e.g. re-testing after a code change, or QA-only
 * re-test cycles. Prerequisite phases must still be approved first.
 */
export const REPEATABLE_PHASES: Record<Track, readonly PhaseType[]> = {
  FULL_SDLC: ['QA'],
  QA_ONLY: ['QA'],
};

/** Statuses that mean a phase run is still "open" (not yet resolved). */
const OPEN_STATUSES: readonly PhaseStatus[] = ['IN_PROGRESS', 'AWAITING_REVIEW'];

/** Minimal view of a phase execution that the engine's decisions depend on. */
export interface ExecutionSummary {
  phaseType: PhaseType;
  status: PhaseStatus;
  runNumber: number;
}

/**
 * Maps persisted phase-execution rows to the minimal {@link ExecutionSummary}
 * shape the engine needs. Prisma's enum values are identical strings to this
 * module's unions, so the cast is safe. Centralized here so the service layer
 * does not duplicate the mapping.
 */
export function toExecutionSummaries(
  executions: { phaseType: string; status: string; runNumber: number }[],
): ExecutionSummary[] {
  return executions.map((e) => ({
    phaseType: e.phaseType as PhaseType,
    status: e.status as PhaseStatus,
    runNumber: e.runNumber,
  }));
}

/** Result of evaluating whether a phase run may be started. */
export interface StartDecision {
  allowed: boolean;
  reason?: string;
}

/** Whether a phase belongs to the given track's sequence. */
export function isPhaseInTrack(track: Track, phase: PhaseType): boolean {
  return PHASE_SEQUENCE[track].includes(phase);
}

/** Whether a phase may be re-run after approval on the given track. */
export function isRepeatable(track: Track, phase: PhaseType): boolean {
  return REPEATABLE_PHASES[track].includes(phase);
}

/** The set of phase types that currently have at least one APPROVED run. */
export function approvedPhaseTypes(executions: ExecutionSummary[]): Set<PhaseType> {
  return new Set(
    executions.filter((e) => e.status === 'APPROVED').map((e) => e.phaseType),
  );
}

/**
 * The next phase that should be run for a project, or `null` when every phase
 * in the track already has an approved run (track complete). This does not
 * account for repeatable re-runs — those are explicit user actions validated
 * by {@link canStartPhase}.
 */
export function getNextPhase(
  track: Track,
  executions: ExecutionSummary[],
): PhaseType | null {
  const approved = approvedPhaseTypes(executions);
  for (const phase of PHASE_SEQUENCE[track]) {
    if (!approved.has(phase)) return phase;
  }
  return null;
}

/** The run number a new execution of `phase` should receive (1-based). */
export function nextRunNumber(executions: ExecutionSummary[], phase: PhaseType): number {
  const runs = executions
    .filter((e) => e.phaseType === phase)
    .map((e) => e.runNumber);
  return runs.length === 0 ? 1 : Math.max(...runs) + 1;
}

/**
 * Decides whether a new run of `phase` may be started, given the project's
 * track and its existing executions. Enforces: phase must belong to the track;
 * no other open run of the same phase; all earlier phases approved; and a
 * non-repeatable phase cannot start again once approved.
 */
export function canStartPhase(
  track: Track,
  phase: PhaseType,
  executions: ExecutionSummary[],
): StartDecision {
  if (!isPhaseInTrack(track, phase)) {
    return { allowed: false, reason: `Phase ${phase} is not part of the ${track} track` };
  }

  const hasOpenRun = executions.some(
    (e) => e.phaseType === phase && OPEN_STATUSES.includes(e.status),
  );
  if (hasOpenRun) {
    return {
      allowed: false,
      reason: `An open ${phase} run already exists; complete or review it first`,
    };
  }

  const sequence = PHASE_SEQUENCE[track];
  const phaseIndex = sequence.indexOf(phase);
  const approved = approvedPhaseTypes(executions);

  for (let i = 0; i < phaseIndex; i += 1) {
    const prerequisite = sequence[i];
    if (!approved.has(prerequisite)) {
      return {
        allowed: false,
        reason: `Phase ${prerequisite} must be approved before starting ${phase}`,
      };
    }
  }

  if (approved.has(phase) && !isRepeatable(track, phase)) {
    return {
      allowed: false,
      reason: `Phase ${phase} is already approved and cannot be repeated on the ${track} track`,
    };
  }

  return { allowed: true };
}

/**
 * Resolves the resulting status of a phase execution after a human review
 * action. Only an AWAITING_REVIEW execution may be reviewed.
 * @throws {Error} if the execution is not awaiting review.
 */
export function resolveReview(current: PhaseStatus, action: ReviewAction): PhaseStatus {
  if (current !== 'AWAITING_REVIEW') {
    throw new Error(
      `Cannot review a phase in status ${current}; expected AWAITING_REVIEW`,
    );
  }
  return action === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
}
