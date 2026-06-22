/**
 * Executes a single claimed step's artifact and produces a result (QAX-3C).
 * HTTP steps run for real here; BROWSER steps are handled by browser.ts (QAX-4).
 * This module performs the HTTP network I/O against the target system.
 */
import {
  HttpArtifact,
  resolvePlaceholders,
  buildUrl,
  isHostAllowed,
  evaluateHttpAssertions,
  ResponseView,
} from './core';

export interface ClaimedStep {
  stepId: string;
  scenarioNo: number;
  order: number;
  stepName: string;
  expectedResult: string;
  artifactType: string | null;
  artifactSpec: unknown;
}

export interface StepResult {
  stepId: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  actualResult?: string;
  durationMs?: number;
  evidence?: string; // base64
  evidenceMime?: string;
  remark?: string;
}

export interface ExecContext {
  baseUrl: string;
  hostAllowlist: string[];
  secrets: Record<string, string>;
  timeoutMs: number;
  /** Per-action/assertion timeout for BROWSER steps (Playwright). */
  browserTimeoutMs: number;
  maxEvidenceBytes: number;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

/** base64 of `text`, capped so a huge body never blows the evidence limit. */
function evidenceFrom(text: string, maxBytes: number): string {
  let b64 = Buffer.from(text, 'utf8').toString('base64');
  if (Buffer.byteLength(b64, 'utf8') > maxBytes) {
    const room = Math.floor((maxBytes * 3) / 4);
    b64 = Buffer.from(text.slice(0, room), 'utf8').toString('base64');
  }
  return b64;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Runs one step and returns its result. Never throws — failures become FAIL. */
export async function runStep(step: ClaimedStep, ctx: ExecContext): Promise<StepResult> {
  // BROWSER steps are dispatched to runBrowserStep by index.ts (they need a
  // Playwright page). Anything else that reaches here is an unknown kind.
  if (step.artifactType !== 'HTTP') {
    return {
      stepId: step.stepId,
      status: 'SKIPPED',
      remark: `${step.artifactType ?? 'non-HTTP'} steps are not supported by this worker`,
    };
  }

  const artifact = step.artifactSpec as HttpArtifact;
  const { value: req, missing } = resolvePlaceholders(artifact.request, ctx.secrets);
  if (missing.length > 0) {
    return {
      stepId: step.stepId,
      status: 'FAIL',
      remark: `missing secret(s): ${missing.join(', ')}`,
      actualResult: `Cannot run: unresolved placeholders ${missing.map((m) => `\${${m}}`).join(', ')}`,
    };
  }

  const url = buildUrl(ctx.baseUrl, req.path, req.query);
  if (!isHostAllowed(url, ctx.hostAllowlist)) {
    return {
      stepId: step.stepId,
      status: 'FAIL',
      remark: `host not on the allowlist: ${url}`,
      actualResult: `Refused: ${url} is not in the project's host allowlist`,
    };
  }

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let bodyInit: string | undefined;
  if (req.body !== undefined && req.method !== 'GET' && req.method !== 'DELETE') {
    bodyInit = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const started = Date.now();
  let view: ResponseView;
  try {
    const r = await fetchWithTimeout(url, { method: req.method, headers, body: bodyInit }, ctx.timeoutMs);
    const bodyText = await r.text();
    const headerMap: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      headerMap[k.toLowerCase()] = v;
    });
    let json: unknown;
    let jsonOk = false;
    try {
      json = JSON.parse(bodyText);
      jsonOk = true;
    } catch {
      jsonOk = false;
    }
    view = { status: r.status, headers: headerMap, bodyText, json, jsonOk };
  } catch (err) {
    return {
      stepId: step.stepId,
      status: 'FAIL',
      durationMs: Date.now() - started,
      remark: `request error: ${(err as Error).message}`,
      actualResult: `Request to ${url} failed: ${(err as Error).message}`,
    };
  }

  const durationMs = Date.now() - started;
  const evalRes = evaluateHttpAssertions(artifact.assertions, view);
  const evidenceText = `${req.method} ${url}\nHTTP ${view.status}\n\n${truncate(view.bodyText, 8000)}`;

  return {
    stepId: step.stepId,
    status: evalRes.passed ? 'PASS' : 'FAIL',
    actualResult: evalRes.passed
      ? `OK — status ${view.status}, all assertions passed`
      : evalRes.failures.join('; '),
    durationMs,
    evidence: evidenceFrom(evidenceText, ctx.maxEvidenceBytes),
    evidenceMime: 'text/plain',
  };
}
