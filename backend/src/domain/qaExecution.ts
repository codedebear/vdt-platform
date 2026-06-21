/**
 * Pure state machine + result roll-up for the QA execution flow (QAX-1).
 *
 * The QA phase is no longer a single LLM generation: it is a staged flow that
 * drafts test scenarios, drafts steps, compiles each step into a replayable
 * artifact, executes the artifacts for real, lets a human review the per-step
 * results, and finally exports a UATR Excel report. This module owns the rules
 * for that flow with **no database / network dependency**, so it can be unit
 * tested in isolation and reused by the service layer (mirrors domain/workflow.ts).
 *
 * The string-literal unions below intentionally mirror the Prisma enums of the
 * same name (QaStage, TestStatus, ScenarioResult). Prisma generates those enums
 * with identical string values, so the two are interchangeable at runtime.
 */

/** The stages a single QA run (TestRun) moves through, in order. */
export type QaStage =
  | 'SCENARIO_DRAFT'
  | 'STEPS_DRAFT'
  | 'COMPILED'
  | 'EXECUTING'
  | 'RESULTS_REVIEW'
  | 'EXPORTED';

/** Per-step execution status (the UATR detail-sheet "Status" column). */
export type TestStatus = 'NOT_START' | 'IN_PROGRESS' | 'PASS' | 'FAIL';

/**
 * Rolled-up result for a scenario or a whole run — the vocabulary the UATR
 * "Test Scenario Summary" sheet uses in its legend.
 */
export type ScenarioResult = 'PASS' | 'FAIL' | 'IN_PROGRESS' | 'NOT_COMPLETE' | 'NO_RUN';

/** What kind of executable a compiled step produces. */
export type TestArtifactType = 'HTTP' | 'BROWSER';

/** Ordered list of stages; index defines "earlier" vs "later". */
export const QA_STAGE_SEQUENCE: readonly QaStage[] = [
  'SCENARIO_DRAFT',
  'STEPS_DRAFT',
  'COMPILED',
  'EXECUTING',
  'RESULTS_REVIEW',
  'EXPORTED',
];

/**
 * Events that drive a run forward through {@link QA_STAGE_SEQUENCE}. Most are
 * human confirmations; EXECUTION_COMPLETE is a system event raised once every
 * step has a recorded result. Each event is legal from exactly one stage.
 */
export type QaEvent =
  | 'CONFIRM_SCENARIOS' // SCENARIO_DRAFT -> STEPS_DRAFT
  | 'CONFIRM_STEPS' //     STEPS_DRAFT   -> COMPILED
  | 'START_RUN' //         COMPILED      -> EXECUTING
  | 'EXECUTION_COMPLETE' // EXECUTING    -> RESULTS_REVIEW (system)
  | 'CONFIRM_RESULTS'; //  RESULTS_REVIEW-> EXPORTED

/** The single forward transition each event performs: [from, to]. */
const FORWARD_TRANSITIONS: Record<QaEvent, readonly [QaStage, QaStage]> = {
  CONFIRM_SCENARIOS: ['SCENARIO_DRAFT', 'STEPS_DRAFT'],
  CONFIRM_STEPS: ['STEPS_DRAFT', 'COMPILED'],
  START_RUN: ['COMPILED', 'EXECUTING'],
  EXECUTION_COMPLETE: ['EXECUTING', 'RESULTS_REVIEW'],
  CONFIRM_RESULTS: ['RESULTS_REVIEW', 'EXPORTED'],
};

/** Position of a stage in the canonical sequence. */
export function stageIndex(stage: QaStage): number {
  return QA_STAGE_SEQUENCE.indexOf(stage);
}

/** A terminal run cannot transition any further. */
export function isTerminalStage(stage: QaStage): boolean {
  return stage === 'EXPORTED';
}

/**
 * The forward event legal from `stage`, or null if the stage has no forward
 * event (only EXPORTED, the terminal stage).
 */
export function forwardEventFor(stage: QaStage): QaEvent | null {
  const entry = (Object.entries(FORWARD_TRANSITIONS) as [QaEvent, readonly [QaStage, QaStage]][])
    .find(([, [from]]) => from === stage);
  return entry ? entry[0] : null;
}

/**
 * Applies a forward {@link QaEvent} to the current stage and returns the next
 * stage.
 * @throws {Error} if the event is not legal from the current stage.
 */
export function advanceStage(current: QaStage, event: QaEvent): QaStage {
  const [from, to] = FORWARD_TRANSITIONS[event];
  if (current !== from) {
    throw new Error(
      `Event ${event} is not allowed from stage ${current}; expected stage ${from}`,
    );
  }
  return to;
}

/**
 * Moves a run **back** to an earlier stage (a "request changes" within the QA
 * flow — e.g. revise steps after seeing the compiled artifacts, or re-run after
 * reviewing failed results). The target must be strictly earlier in the
 * sequence; a terminal (EXPORTED) run cannot be revised.
 * @throws {Error} if the target is not strictly earlier, or the run is terminal.
 */
export function reviseStage(current: QaStage, target: QaStage): QaStage {
  if (isTerminalStage(current)) {
    throw new Error('Cannot revise an EXPORTED run');
  }
  if (stageIndex(target) >= stageIndex(current)) {
    throw new Error(
      `Cannot revise from ${current} to ${target}; target must be an earlier stage`,
    );
  }
  return target;
}

/**
 * Rolls a scenario's per-step statuses up to a single {@link ScenarioResult}
 * for the UATR summary. Precedence is deliberate and ordered:
 *  - no steps, or every step NOT_START  -> NO_RUN
 *  - any step IN_PROGRESS               -> IN_PROGRESS
 *  - some steps finished but some still NOT_START -> NOT_COMPLETE
 *  - all steps finished, any FAIL       -> FAIL
 *  - all steps PASS                     -> PASS
 */
export function rollUpScenario(statuses: readonly TestStatus[]): ScenarioResult {
  if (statuses.length === 0 || statuses.every((s) => s === 'NOT_START')) {
    return 'NO_RUN';
  }
  if (statuses.some((s) => s === 'IN_PROGRESS')) {
    return 'IN_PROGRESS';
  }
  if (statuses.some((s) => s === 'NOT_START')) {
    return 'NOT_COMPLETE';
  }
  return statuses.some((s) => s === 'FAIL') ? 'FAIL' : 'PASS';
}

/**
 * Rolls a run's scenario results up to one overall {@link ScenarioResult}.
 * Mirrors {@link rollUpScenario}'s precedence one level higher:
 *  - no scenarios, or every scenario NO_RUN -> NO_RUN
 *  - any scenario IN_PROGRESS               -> IN_PROGRESS
 *  - any scenario NO_RUN or NOT_COMPLETE (mixed with progress) -> NOT_COMPLETE
 *  - any scenario FAIL                      -> FAIL
 *  - all scenarios PASS                     -> PASS
 */
export function rollUpRun(results: readonly ScenarioResult[]): ScenarioResult {
  if (results.length === 0 || results.every((r) => r === 'NO_RUN')) {
    return 'NO_RUN';
  }
  if (results.some((r) => r === 'IN_PROGRESS')) {
    return 'IN_PROGRESS';
  }
  if (results.some((r) => r === 'NO_RUN' || r === 'NOT_COMPLETE')) {
    return 'NOT_COMPLETE';
  }
  return results.some((r) => r === 'FAIL') ? 'FAIL' : 'PASS';
}

/** Whether every step has a terminal (PASS/FAIL) result — i.e. execution done. */
export function isExecutionComplete(statuses: readonly TestStatus[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === 'PASS' || s === 'FAIL');
}
