/**
 * Thin client for the VDT backend worker API (QAX-3B). Talks to
 * /api/worker/jobs/* with the shared worker token.
 */
import { ClaimedStep, StepResult } from './runner';

export interface WorkerConfig {
  apiUrl: string; // e.g. http://192.168.1.13:4000
  token: string;
  workerId: string;
  pollMs: number;
  heartbeatMs: number;
  timeoutMs: number;
  browserTimeoutMs: number;
  maxEvidenceBytes: number;
}

export interface Job {
  runId: string;
  executionId: string;
  baseUrl: string;
  hostAllowlist: string[];
  secrets: Record<string, string>;
  steps: ClaimedStep[];
  leaseExpiresAt: string;
}

function authHeaders(cfg: WorkerConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };
}

/** Claims the next job, or null when the queue is empty (204). */
export async function claim(cfg: WorkerConfig): Promise<Job | null> {
  const r = await fetch(`${cfg.apiUrl}/api/worker/jobs/claim`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ workerId: cfg.workerId }),
  });
  if (r.status === 204) return null;
  if (!r.ok) {
    throw new Error(`claim failed: ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as { job: Job };
  return data.job;
}

/** Renews the lease on a run this worker holds. */
export async function heartbeat(cfg: WorkerConfig, runId: string): Promise<void> {
  const r = await fetch(`${cfg.apiUrl}/api/worker/jobs/${runId}/heartbeat`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ workerId: cfg.workerId }),
  });
  if (!r.ok) {
    throw new Error(`heartbeat failed: ${r.status}`);
  }
}

export interface SubmitOutcome {
  runId: string;
  finalized: boolean;
  stage: string;
  overallResult: string | null;
}

/** Submits step results; the backend finalizes the run when all are terminal. */
export async function submit(
  cfg: WorkerConfig,
  runId: string,
  results: StepResult[],
): Promise<SubmitOutcome> {
  const r = await fetch(`${cfg.apiUrl}/api/worker/jobs/${runId}/results`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify({ workerId: cfg.workerId, results }),
  });
  if (!r.ok) {
    throw new Error(`submit failed: ${r.status} ${await r.text()}`);
  }
  return (await r.json()) as SubmitOutcome;
}
