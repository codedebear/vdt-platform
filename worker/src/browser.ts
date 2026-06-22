/**
 * Browser (Playwright) execution for the VDT QA worker (QAX-4).
 *
 * Runs a compiled BROWSER artifact (ordered actions + assertions) for one test
 * step against the project's non-prod target, using a headless Chromium page
 * supplied by index.ts (one browser context per scenario, so steps in a scenario
 * share session state). Selectors are resilient locators mapped to Playwright
 * getBy* (testId > role+name > label > text > css). `${VAR}` placeholders in
 * action values / selector text / goto path are resolved from the secrets map at
 * execute time. Evidence = a viewport-only screenshot per step.
 *
 * The pure helpers (planSelector / selectorDescription) are unit-tested; the
 * page-driving parts are verified by a real browser run on the worker host.
 */
import type { Page, Locator } from 'playwright';
import { Selector, resolvePlaceholders, buildUrl, isHostAllowed } from './core';
import type { ClaimedStep, StepResult, ExecContext } from './runner';

/** A single Playwright action (mirrors the backend BROWSER artifact contract). */
export type BrowserAction =
  | { type: 'goto'; path: string }
  | { type: 'click'; selector: Selector }
  | { type: 'fill'; selector: Selector; value: string }
  | { type: 'select'; selector: Selector; value: string }
  | { type: 'waitFor'; selector: Selector };

/** A browser-step assertion (mirrors the backend BROWSER artifact contract). */
export type BrowserAssertion =
  | { type: 'textVisible'; text: string }
  | { type: 'urlContains'; text: string }
  | { type: 'elementVisible'; selector: Selector };

/** The compiled BROWSER artifact attached to a step. */
export interface BrowserArtifact {
  kind: 'BROWSER';
  actions: BrowserAction[];
  assertions: BrowserAssertion[];
}

/** A resolved locator strategy — picked by resilience precedence. */
export type SelectorPlan =
  | { strategy: 'testId'; value: string }
  | { strategy: 'role'; role: string; name?: string }
  | { strategy: 'label'; value: string }
  | { strategy: 'text'; value: string }
  | { strategy: 'css'; value: string };

/**
 * Picks the single most-resilient locator strategy from a selector.
 * Precedence: testId > role(+name) > label > text > css. Throws only if the
 * selector is empty (the backend contract guarantees at least one field).
 */
export function planSelector(sel: Selector): SelectorPlan {
  if (sel.testId) return { strategy: 'testId', value: sel.testId };
  if (sel.role) return { strategy: 'role', role: sel.role, name: sel.name };
  if (sel.label) return { strategy: 'label', value: sel.label };
  if (sel.text) return { strategy: 'text', value: sel.text };
  if (sel.css) return { strategy: 'css', value: sel.css };
  throw new Error('selector has none of testId/role/label/text/css');
}

/** A short human-readable description of a selector, for logs and remarks. */
export function selectorDescription(sel: Selector): string {
  if (sel.testId) return `testId=${sel.testId}`;
  if (sel.role) return `role=${sel.role}${sel.name ? `[name="${sel.name}"]` : ''}`;
  if (sel.label) return `label="${sel.label}"`;
  if (sel.text) return `text="${sel.text}"`;
  if (sel.css) return `css=${sel.css}`;
  return '(empty selector)';
}

/** Maps a resilient selector onto a Playwright Locator for `page`. */
export function applySelector(page: Page, sel: Selector): Locator {
  const plan = planSelector(sel);
  switch (plan.strategy) {
    case 'testId':
      return page.getByTestId(plan.value);
    case 'role':
      return page.getByRole(
        plan.role as Parameters<Page['getByRole']>[0],
        plan.name ? { name: plan.name } : undefined,
      );
    case 'label':
      return page.getByLabel(plan.value);
    case 'text':
      return page.getByText(plan.value);
    case 'css':
      return page.locator(plan.value);
  }
}

/** Captures a viewport-only screenshot as base64, within the evidence cap. */
async function captureEvidence(
  page: Page,
  maxBytes: number,
): Promise<{ evidence?: string; evidenceMime?: string }> {
  try {
    const png = await page.screenshot({ fullPage: false });
    let b64 = png.toString('base64');
    if (Buffer.byteLength(b64, 'utf8') <= maxBytes) {
      return { evidence: b64, evidenceMime: 'image/png' };
    }
    // PNG too big — fall back to a compressed JPEG of the same viewport.
    const jpg = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 60 });
    b64 = jpg.toString('base64');
    if (Buffer.byteLength(b64, 'utf8') <= maxBytes) {
      return { evidence: b64, evidenceMime: 'image/jpeg' };
    }
    return {}; // still over cap → submit no image rather than a truncated one
  } catch {
    return {};
  }
}

/** Runs one action against the page. Throws on failure (caller turns it into FAIL). */
async function runAction(page: Page, action: BrowserAction, ctx: ExecContext): Promise<void> {
  const timeout = ctx.browserTimeoutMs;
  switch (action.type) {
    case 'goto': {
      const url = buildUrl(ctx.baseUrl, action.path);
      if (!isHostAllowed(url, ctx.hostAllowlist)) {
        throw new Error(`host not on the allowlist: ${url}`);
      }
      await page.goto(url, { waitUntil: 'load', timeout });
      return;
    }
    case 'click':
      await applySelector(page, action.selector).click({ timeout });
      return;
    case 'fill':
      await applySelector(page, action.selector).fill(action.value, { timeout });
      return;
    case 'select':
      await applySelector(page, action.selector).selectOption(action.value, { timeout });
      return;
    case 'waitFor':
      await applySelector(page, action.selector).first().waitFor({ state: 'visible', timeout });
      return;
  }
}

/** True if a locator becomes visible within the timeout (never throws). */
async function isVisibleWithin(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** Evaluates all browser assertions; PASS only if every one holds. */
async function evaluateBrowserAssertions(
  page: Page,
  assertions: BrowserAssertion[],
  ctx: ExecContext,
): Promise<{ passed: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (const a of assertions) {
    switch (a.type) {
      case 'textVisible':
        if (!(await isVisibleWithin(page.getByText(a.text), ctx.browserTimeoutMs))) {
          failures.push(`text "${a.text}" not visible`);
        }
        break;
      case 'urlContains': {
        const url = page.url();
        if (!url.includes(a.text)) {
          failures.push(`url "${url}" does not contain "${a.text}"`);
        }
        break;
      }
      case 'elementVisible':
        if (!(await isVisibleWithin(applySelector(page, a.selector), ctx.browserTimeoutMs))) {
          failures.push(`element ${selectorDescription(a.selector)} not visible`);
        }
        break;
    }
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Runs one BROWSER step on `page` and returns its result. Never throws — any
 * navigation/locator error becomes a FAIL (with a best-effort screenshot).
 */
export async function runBrowserStep(
  step: ClaimedStep,
  ctx: ExecContext,
  page: Page,
): Promise<StepResult> {
  const raw = step.artifactSpec as BrowserArtifact;
  // Resolve ${VAR} across the whole artifact (goto path, selector text, fill values).
  const { value: artifact, missing } = resolvePlaceholders(raw, ctx.secrets);
  if (missing.length > 0) {
    return {
      stepId: step.stepId,
      status: 'FAIL',
      remark: `missing secret(s): ${missing.join(', ')}`,
      actualResult: `Cannot run: unresolved placeholders ${missing.map((m) => `\${${m}}`).join(', ')}`,
    };
  }

  const started = Date.now();
  try {
    for (const action of artifact.actions) {
      await runAction(page, action, ctx);
    }
    const evalRes = await evaluateBrowserAssertions(page, artifact.assertions, ctx);
    const durationMs = Date.now() - started;
    const { evidence, evidenceMime } = await captureEvidence(page, ctx.maxEvidenceBytes);
    return {
      stepId: step.stepId,
      status: evalRes.passed ? 'PASS' : 'FAIL',
      actualResult: evalRes.passed
        ? `OK — all browser assertions passed (final url ${page.url()})`
        : evalRes.failures.join('; '),
      durationMs,
      evidence,
      evidenceMime,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const { evidence, evidenceMime } = await captureEvidence(page, ctx.maxEvidenceBytes);
    const message = (err as Error).message;
    return {
      stepId: step.stepId,
      status: 'FAIL',
      durationMs,
      remark: `browser error: ${message}`,
      actualResult: `Browser step failed: ${message}`,
      evidence,
      evidenceMime,
    };
  }
}
