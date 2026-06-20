/**
 * Frontend mirror of the backend's pure workflow engine
 * (`backend/src/domain/workflow.ts`). Used purely for UI decisions — which
 * phases the user may start right now — so the screens stay consistent with the
 * server's rules. The server remains the source of truth and re-validates every
 * action; this only shapes what the UI offers.
 *
 * The string-literal unions match the Prisma enums exactly (same values).
 */
import type { PhaseStatus, PhaseType, Track } from './types';

/** Ordered phases that make up each track. */
export const PHASE_SEQUENCE: Record<Track, readonly PhaseType[]> = {
  FULL_SDLC: ['PLANNER', 'DEV', 'QA', 'CODE_REVIEW', 'DOCS'],
  QA_ONLY: ['PLANNER', 'QA'],
};

/** Phases that may be re-run after approval (a fresh execution per run). */
export const REPEATABLE_PHASES: Record<Track, readonly PhaseType[]> = {
  FULL_SDLC: ['QA'],
  QA_ONLY: ['QA'],
};

/** Statuses that mean a phase run is still "open" (not yet resolved). */
const OPEN_STATUSES: readonly PhaseStatus[] = ['IN_PROGRESS', 'AWAITING_REVIEW'];

/** Minimal execution shape the engine's decisions depend on. */
export interface ExecutionSummary {
  phaseType: PhaseType;
  status: PhaseStatus;
}

export function isPhaseInTrack(track: Track, phase: PhaseType): boolean {
  return PHASE_SEQUENCE[track].includes(phase);
}

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
 * Whether a new run of `phase` may be started given the project's track and
 * existing executions. Mirrors the backend's `canStartPhase` rules: phase must
 * belong to the track; no other open run of the same phase; all earlier phases
 * approved; a non-repeatable phase cannot start again once approved.
 */
export function canStartPhase(
  track: Track,
  phase: PhaseType,
  executions: ExecutionSummary[],
): boolean {
  if (!isPhaseInTrack(track, phase)) return false;

  const hasOpenRun = executions.some(
    (e) => e.phaseType === phase && OPEN_STATUSES.includes(e.status),
  );
  if (hasOpenRun) return false;

  const sequence = PHASE_SEQUENCE[track];
  const phaseIndex = sequence.indexOf(phase);
  const approved = approvedPhaseTypes(executions);

  for (let i = 0; i < phaseIndex; i += 1) {
    if (!approved.has(sequence[i])) return false;
  }

  if (approved.has(phase) && !isRepeatable(track, phase)) return false;

  return true;
}

/**
 * Every phase the user could start right now (the next unapproved phase plus
 * any approved-but-repeatable phase whose prerequisites are met and that has no
 * open run). Returned in track order.
 */
export function getStartablePhases(
  track: Track,
  executions: ExecutionSummary[],
): PhaseType[] {
  return PHASE_SEQUENCE[track].filter((phase) =>
    canStartPhase(track, phase, executions),
  );
}
