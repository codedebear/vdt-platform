/**
 * VDT QA execution worker (QAX-3C / QAX-4) — entry point.
 *
 * Polls the backend for EXECUTING runs, executes each step's compiled artifact
 * against the project's non-prod target, heartbeats to hold the lease, and submits
 * results. Designed to run continuously on a dedicated machine (a Docker container
 * on the worker host). HTTP steps run via runStep; BROWSER steps run on a headless
 * Chromium page — one browser context per scenario, so steps within a scenario
 * share session state (e.g. login) while scenarios stay isolated.
 *
 * Run with: npm start  (reads config from environment / .env)
 */
import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { claim, heartbeat, submit, WorkerConfig, Job } from './api';
import { runStep, StepResult, ExecContext } from './runner';
import { runBrowserStep } from './browser';

function loadConfig(): WorkerConfig {
  const apiUrl = process.env.VDT_API_URL;
  const token = process.env.WORKER_TOKEN;
  if (!apiUrl || !token) {
    throw new Error('VDT_API_URL and WORKER_TOKEN are required');
  }
  const leaseMs = Number(process.env.WORKER_LEASE_MS ?? 120000);
  return {
    apiUrl: apiUrl.replace(/\/$/, ''),
    token,
    workerId: process.env.WORKER_ID ?? `worker-${process.pid}`,
    pollMs: Number(process.env.WORKER_POLL_MS ?? 5000),
    // Heartbeat at half the lease so a long run is never reclaimed mid-flight.
    heartbeatMs: Math.max(5000, Math.floor(leaseMs / 2)),
    timeoutMs: Number(process.env.WORKER_HTTP_TIMEOUT_MS ?? 30000),
    browserTimeoutMs: Number(process.env.WORKER_BROWSER_TIMEOUT_MS ?? 30000),
    maxEvidenceBytes: Number(process.env.WORKER_MAX_EVIDENCE_BYTES ?? 1_500_000),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = true;

async function runJob(cfg: WorkerConfig, job: Job): Promise<void> {
  console.log(`[job] claimed run ${job.runId} (${job.steps.length} steps) → ${job.baseUrl}`);
  const ctx: ExecContext = {
    baseUrl: job.baseUrl,
    hostAllowlist: job.hostAllowlist,
    secrets: job.secrets,
    timeoutMs: cfg.timeoutMs,
    browserTimeoutMs: cfg.browserTimeoutMs,
    maxEvidenceBytes: cfg.maxEvidenceBytes,
  };

  // Hold the lease while we work.
  const beat = setInterval(() => {
    heartbeat(cfg, job.runId).catch((e) => console.warn(`[job] heartbeat: ${e.message}`));
  }, cfg.heartbeatMs);

  // Lazy browser, with one context per scenario (steps in a scenario share state).
  let browser: Browser | null = null;
  let curScenario: number | null = null;
  let curContext: BrowserContext | null = null;
  let curPage: Page | null = null;

  const closeScenario = async (): Promise<void> => {
    if (curContext) {
      await curContext.close().catch(() => undefined);
    }
    curContext = null;
    curPage = null;
  };

  const results: StepResult[] = [];
  try {
    for (const step of job.steps) {
      let res: StepResult;
      if (step.artifactType === 'BROWSER') {
        if (!browser) {
          browser = await chromium.launch({ headless: true });
          console.log('[job] launched headless Chromium');
        }
        if (curScenario !== step.scenarioNo || !curPage) {
          await closeScenario();
          curScenario = step.scenarioNo;
          curContext = await browser.newContext();
          curPage = await curContext.newPage();
          curPage.setDefaultTimeout(cfg.browserTimeoutMs);
        }
        res = await runBrowserStep(step, ctx, curPage);
      } else {
        res = await runStep(step, ctx);
      }
      console.log(`  [${res.status}] s${step.scenarioNo}.${step.order} ${step.stepName.slice(0, 60)}`);
      results.push(res);
    }
  } finally {
    clearInterval(beat);
    await closeScenario();
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  const outcome = await submit(cfg, job.runId, results);
  console.log(
    `[job] submitted ${results.length} results — ${outcome.finalized ? `finalized: ${outcome.overallResult}` : `stage ${outcome.stage}`}`,
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`VDT QA worker "${cfg.workerId}" → ${cfg.apiUrl} (poll ${cfg.pollMs}ms)`);

  while (running) {
    let job: Job | null = null;
    try {
      job = await claim(cfg);
    } catch (e) {
      console.warn(`[poll] claim error: ${(e as Error).message}`);
      await sleep(cfg.pollMs);
      continue;
    }
    if (!job) {
      await sleep(cfg.pollMs);
      continue;
    }
    try {
      await runJob(cfg, job);
    } catch (e) {
      // A job-level failure (e.g. lease lost) should not kill the worker.
      console.error(`[job] error on run ${job.runId}: ${(e as Error).message}`);
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} received — shutting down after the current poll.`);
    running = false;
  });
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
