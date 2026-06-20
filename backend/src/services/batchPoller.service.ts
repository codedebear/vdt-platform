/**
 * Background poller for asynchronous Batch-API generations (BE-BATCH-1).
 *
 * Runs IN_PROGRESS → [generate, mode=batch] → QUEUED; this poller scans QUEUED
 * runs, checks each run's Anthropic batch, and — once the batch has ended —
 * retrieves the result and settles the run to AWAITING_REVIEW or FAILED via
 * phase.service. Because it works purely from the persisted `batchId`, it
 * recovers any runs left QUEUED across a process restart.
 *
 * It runs in-process (a single backend instance on the Pi). A module-level
 * re-entrancy guard prevents overlapping ticks from double-processing; the
 * settle step is additionally idempotent (it only acts on a still-QUEUED run).
 */
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import {
  retrieveBatch,
  collectBatchResults,
  parseGenerationResponse,
  BatchGenerationClient,
} from './generation.service';
import { isBatchEnded, outcomeForResultType, missingResultOutcome } from '../domain/batch';
import { settleBatchRun, QueuedRunRef } from './phase.service';

let polling = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Performs one scan of all QUEUED runs: for each, retrieve its batch; if ended,
 * fetch results, map the matching result to an outcome, and settle the run. A
 * transient upstream error for one run is logged and the run is left QUEUED for
 * the next tick; a result with no usable text is treated as a terminal failure.
 * Exposed for tests and the QA smoke (can be invoked with an injected client).
 */
export async function pollQueuedBatches(client?: BatchGenerationClient): Promise<void> {
  // Includes runs whose batchId is still null (submitted-pending or a submit that
  // crashed) so they can be reconciled, not just runs with a known batch.
  const runs = await prisma.phaseExecution.findMany({
    where: { status: 'QUEUED' },
    select: { id: true, projectId: true, batchId: true, costUsd: true, updatedAt: true },
  });
  const now = Date.now();

  for (const run of runs) {
    const ref: QueuedRunRef = {
      id: run.id,
      projectId: run.projectId,
      reservedUsd: run.costUsd ?? 0,
    };
    const ageMs = now - run.updatedAt.getTime();

    // A QUEUED run that never got a batchId is a crashed/failed submission once
    // the grace period passes; fail it and release the reservation.
    if (!run.batchId) {
      if (ageMs > env.batchSubmitGraceMs) {
        await settleBatchRun(ref, {
          status: 'FAILED',
          succeeded: false,
          reason: 'Batch submission did not complete',
        });
      }
      continue;
    }

    // Hard age cutoff so a run never sticks in QUEUED forever (well past the 24h
    // batch SLA): fail it and release the reservation regardless of batch state.
    if (ageMs > env.batchMaxAgeMs) {
      await settleBatchRun(ref, {
        status: 'FAILED',
        succeeded: false,
        reason: 'Batch exceeded the maximum wait time and was abandoned',
      });
      continue;
    }

    try {
      const handle = await retrieveBatch(run.batchId, client);
      if (!isBatchEnded(handle.processing_status)) {
        continue;
      }

      const results = await collectBatchResults(run.batchId, client);
      const match = results.find((r) => r.custom_id === run.id);
      if (!match) {
        await settleBatchRun(ref, missingResultOutcome());
        continue;
      }

      const outcome = outcomeForResultType(match.result.type);
      if (!outcome.succeeded) {
        await settleBatchRun(ref, outcome);
        continue;
      }

      // Succeeded: parse the message into text + usage. An empty/absent message
      // is a terminal failure (not retried) so the run never sticks in QUEUED.
      if (!match.result.message) {
        await settleBatchRun(ref, {
          status: 'FAILED',
          succeeded: false,
          reason: 'Batch result was marked succeeded but carried no message',
        });
        continue;
      }
      try {
        const parsed = parseGenerationResponse(match.result.message);
        await settleBatchRun(ref, outcome, parsed);
      } catch {
        await settleBatchRun(ref, {
          status: 'FAILED',
          succeeded: false,
          reason: 'Batch result had no usable text',
        });
      }
    } catch (err) {
      // A terminal 404 (the batch no longer exists upstream) fails the run so it
      // does not poll forever; everything else is transient — log and leave the
      // run QUEUED for the next tick (the age cutoff above is the final backstop).
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AppError && err.statusCode === 404) {
        // eslint-disable-next-line no-console
        console.error(`Batch ${run.batchId} not found upstream for run ${run.id}; failing it`);
        await settleBatchRun(ref, {
          status: 'FAILED',
          succeeded: false,
          reason: 'Batch no longer exists upstream',
        });
      } else {
        // eslint-disable-next-line no-console
        console.error(`Batch poll error for run ${run.id}:`, message);
      }
    }
  }
}

/** One guarded tick: skips if a previous tick is still running. */
async function tick(client?: BatchGenerationClient): Promise<void> {
  if (polling) {
    return;
  }
  polling = true;
  try {
    await pollQueuedBatches(client);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Batch poller tick failed:', message);
  } finally {
    polling = false;
  }
}

/**
 * Starts the background poller (no-op if BATCH_ENABLED is false or it is already
 * running). It runs one tick immediately — to finish any runs left QUEUED across
 * a restart — then on a fixed interval. Returns a stop function.
 */
export function startBatchPoller(client?: BatchGenerationClient): () => void {
  if (!env.batchEnabled) {
    // eslint-disable-next-line no-console
    console.log('Batch poller disabled (BATCH_ENABLED=false)');
    return () => undefined;
  }
  if (timer) {
    return stopBatchPoller;
  }
  void tick(client);
  timer = setInterval(() => void tick(client), env.batchPollIntervalMs);
  // eslint-disable-next-line no-console
  console.log(`Batch poller started (interval ${env.batchPollIntervalMs}ms)`);
  return stopBatchPoller;
}

/** Stops the background poller if running. */
export function stopBatchPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
