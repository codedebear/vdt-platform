/**
 * Pure helpers for the Anthropic Message Batches workflow (BE-BATCH-1).
 *
 * These map the Batch API's status vocabulary to this project's phase-execution
 * lifecycle, with no I/O so they can be unit-tested in isolation. The poller
 * (services/batchPoller.service.ts) owns the database and network; this module
 * only decides "given a batch/result status, what should the run become?".
 */
import { PhaseStatus } from './workflow';

/** Anthropic batch-level processing status (BetaMessageBatch.processing_status). */
export type BatchProcessingStatus = 'in_progress' | 'canceling' | 'ended';

/** Per-request result type within a finished batch (BetaMessageBatchResult.type). */
export type BatchResultType = 'succeeded' | 'errored' | 'canceled' | 'expired';

/**
 * Whether a batch has finished processing every request. Only an `ended` batch
 * has results to retrieve; `in_progress`/`canceling` batches are polled again.
 */
export function isBatchEnded(status: BatchProcessingStatus): boolean {
  return status === 'ended';
}

/** The outcome of settling one batch result onto its phase run. */
export interface BatchOutcome {
  /** The status the run should transition to. */
  status: Extract<PhaseStatus, 'AWAITING_REVIEW' | 'FAILED'>;
  /** Whether the generation succeeded (output is usable). */
  succeeded: boolean;
  /** Human-readable reason stored on the run when it failed. */
  reason?: string;
}

/**
 * Maps a single batch result type to the phase-run outcome. A `succeeded`
 * result yields AWAITING_REVIEW (the generated output goes to a human review
 * gate, exactly like a synchronous generation); every non-success terminal type
 * yields FAILED with a descriptive reason so the budget reservation is released.
 */
export function outcomeForResultType(type: BatchResultType): BatchOutcome {
  switch (type) {
    case 'succeeded':
      return { status: 'AWAITING_REVIEW', succeeded: true };
    case 'errored':
      return { status: 'FAILED', succeeded: false, reason: 'Batch request errored' };
    case 'canceled':
      return { status: 'FAILED', succeeded: false, reason: 'Batch request was canceled' };
    case 'expired':
      return {
        status: 'FAILED',
        succeeded: false,
        reason: 'Batch request expired before completing (24h limit)',
      };
    default: {
      // Exhaustiveness guard: a new result type must be handled explicitly.
      const never: never = type;
      return { status: 'FAILED', succeeded: false, reason: `Unknown batch result: ${never}` };
    }
  }
}

/**
 * The outcome when a batch ended but contains no result matching the run's
 * custom_id (should not happen for a single-request batch, but is handled
 * defensively so a run never gets stuck in QUEUED).
 */
export function missingResultOutcome(): BatchOutcome {
  return {
    status: 'FAILED',
    succeeded: false,
    reason: 'Batch ended but no matching result was found for this run',
  };
}
