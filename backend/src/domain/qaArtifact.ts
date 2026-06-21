/**
 * The compiled test-artifact contract (QAX-2B-2) — the deterministic, replayable
 * spec the execution worker (QAX-3/4) runs for one test step. Defined as zod
 * schemas so both the compile parser and (later) the executor validate the exact
 * same shape. Pure: no I/O, unit-tested directly.
 *
 * Design rules (locked with the user):
 *  - Two kinds per step: HTTP (an API request + assertions) and BROWSER
 *    (ordered Playwright actions + assertions).
 *  - Selectors are resilient locators (role/name, label, text, testId) mapping to
 *    Playwright getBy*, with a `css` fallback — not brittle raw CSS.
 *  - `path` is RELATIVE; the target base URL is injected at execute time.
 *  - Secrets / test data use `${VAR}` placeholders resolved from the per-project
 *    secrets vault at execute time — never the real value baked into the spec.
 */
import { z } from 'zod';

/**
 * A resilient element locator. At least one field must be present. Mapped at
 * execution time to Playwright: role(+name) → getByRole, label → getByLabel,
 * text → getByText, testId → getByTestId, css → locator(css) as a last resort.
 */
export const selectorSchema = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    css: z.string().min(1).optional(),
  })
  .strip()
  .refine(
    (s) => !!(s.role || s.label || s.text || s.testId || s.css),
    'a selector needs at least one of role, label, text, testId or css',
  );

/** Assertions for an HTTP response. */
export const httpAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('statusCode'), equals: z.number().int() }).strip(),
  z
    .object({
      type: z.literal('jsonPath'),
      path: z.string().min(1),
      equals: z.unknown().optional(),
      exists: z.boolean().optional(),
    })
    .strip(),
  z.object({ type: z.literal('bodyContains'), text: z.string().min(1) }).strip(),
  z
    .object({ type: z.literal('headerContains'), name: z.string().min(1), text: z.string().min(1) })
    .strip(),
]);

/** An HTTP API call + the assertions that decide pass/fail. */
export const httpArtifactSchema = z
  .object({
    kind: z.literal('HTTP'),
    request: z
      .object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1),
        headers: z.record(z.string()).optional(),
        query: z.record(z.string()).optional(),
        body: z.unknown().optional(),
      })
      .strip(),
    assertions: z.array(httpAssertionSchema).min(1, 'at least one assertion is required'),
  })
  .strip();

/** One Playwright action in a browser step. */
export const browserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goto'), path: z.string().min(1) }).strip(),
  z.object({ type: z.literal('click'), selector: selectorSchema }).strip(),
  z.object({ type: z.literal('fill'), selector: selectorSchema, value: z.string() }).strip(),
  z.object({ type: z.literal('select'), selector: selectorSchema, value: z.string() }).strip(),
  z.object({ type: z.literal('waitFor'), selector: selectorSchema }).strip(),
]);

/** Assertions for a browser step. */
export const browserAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('textVisible'), text: z.string().min(1) }).strip(),
  z.object({ type: z.literal('urlContains'), text: z.string().min(1) }).strip(),
  z.object({ type: z.literal('elementVisible'), selector: selectorSchema }).strip(),
]);

/** An ordered browser interaction + the assertions that decide pass/fail. */
export const browserArtifactSchema = z
  .object({
    kind: z.literal('BROWSER'),
    actions: z.array(browserActionSchema).min(1, 'at least one action is required'),
    assertions: z.array(browserAssertionSchema).min(1, 'at least one assertion is required'),
  })
  .strip();

/** The compiled artifact for a step — either an HTTP call or a browser sequence. */
export const artifactSpecSchema = z.discriminatedUnion('kind', [
  httpArtifactSchema,
  browserArtifactSchema,
]);

export type Selector = z.infer<typeof selectorSchema>;
export type HttpArtifact = z.infer<typeof httpArtifactSchema>;
export type BrowserArtifact = z.infer<typeof browserArtifactSchema>;
export type ArtifactSpec = z.infer<typeof artifactSpecSchema>;

/** The artifact kind, matching the Prisma `TestArtifactType` enum. */
export type ArtifactKind = ArtifactSpec['kind'];
