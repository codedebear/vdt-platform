/**
 * Pure prompt construction for the QA execution flow (QAX-2).
 *
 * Separate from domain/prompts.ts (which builds the single-deliverable phase
 * prompts): the QA execution flow asks Claude for *structured* output it can
 * parse into TestScenario / TestStep rows, so these builders demand strict JSON
 * and describe the exact shape. Like the other domain modules this has no I/O and
 * is unit-tested in isolation; the service supplies the runtime data and folds in
 * any attachment text.
 */

/** The pair of messages handed to the Claude API. */
export interface BuiltQaPrompt {
  system: string;
  user: string;
}

/** A scenario already drafted on the run, passed back in for a guided revision. */
export interface ScenarioContext {
  topic: string;
  testName: string;
  system?: string;
  remark?: string;
}

/** Everything the scenario-draft prompt needs about the QA run. */
export interface QaScenarioPromptContext {
  projectName: string;
  description?: string;
  /** The run's free-form input: an SRS, API spec, endpoint list, or test scope. */
  input?: string;
  /**
   * Reviewer feedback steering a regeneration. When present (with
   * {@link currentScenarios}), the model REVISES the existing list per the
   * feedback rather than drafting from scratch.
   */
  feedback?: string;
  /** The current drafted scenarios to revise (paired with {@link feedback}). */
  currentScenarios?: ScenarioContext[];
}

/**
 * Builds the system + user prompt that asks Claude to propose UAT test scenarios
 * from the supplied specification/context. The model must return ONLY a JSON
 * array (no prose, no Markdown fences) of objects shaped:
 *   { "topic": string, "testName": string, "system"?: string, "remark"?: string }
 * matching the UATR "Detail Test Scenario Summary" columns (Topic, Test Name,
 * System, Remark). Steps are NOT requested here — they are a later stage.
 *
 * When `feedback` and `currentScenarios` are supplied, the prompt switches to a
 * REVISION task: the model is given the current list and the reviewer's feedback
 * and must return the full updated array (keeping good scenarios, applying the
 * requested additions/changes/removals) — this powers the review → regenerate →
 * review loop before the scenarios are confirmed.
 */
export function buildScenarioPrompt(ctx: QaScenarioPromptContext): BuiltQaPrompt {
  const isRevision =
    !!ctx.feedback &&
    ctx.feedback.trim().length > 0 &&
    !!ctx.currentScenarios &&
    ctx.currentScenarios.length > 0;

  const system = [
    'You are the QA test designer of an automated QA team at Code De Bear, a Thai IT',
    'solutions provider. From the provided specification and context, propose a thorough',
    'set of black-box User Acceptance Test (UAT) scenarios for the system under test.',
    'Cover the main success paths, validation and error cases, and important edge cases.',
    'Group related scenarios under a shared "topic".',
    isRevision
      ? 'You are REVISING an existing scenario list according to reviewer feedback: keep the scenarios that are still valid, and add, modify, or remove scenarios as the feedback directs. Return the FULL updated list, not just the changes.'
      : '',
    'Return ONLY a JSON array — no prose, no explanation, no Markdown code fences.',
    'Each array element must be an object with exactly these keys:',
    '"topic" (string, the group this scenario belongs to),',
    '"testName" (string, a concise description of what this scenario validates),',
    '"system" (string, optional — the component or module under test, e.g. "Customer Portal"),',
    '"remark" (string, optional — any note such as preconditions or test data).',
    'Do NOT include test steps or expected results; those are produced in a later stage.',
    'Do NOT number the scenarios; ordering is assigned by the platform.',
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  const parts: string[] = [];
  parts.push(`# Project: ${ctx.projectName}`);
  if (ctx.description && ctx.description.trim().length > 0) {
    parts.push(`Description: ${ctx.description.trim()}`);
  }
  if (ctx.input && ctx.input.trim().length > 0) {
    parts.push(`\n## Specification / context to derive scenarios from\n${ctx.input.trim()}`);
  }

  if (isRevision) {
    parts.push(
      `\n## Current scenarios (revise these)\n${JSON.stringify(ctx.currentScenarios, null, 2)}`,
    );
    parts.push(`\n## Reviewer feedback — apply this\n${ctx.feedback!.trim()}`);
    parts.push(
      '\n## Your task\nReturn the full revised JSON array of test scenarios, incorporating the feedback, now.',
    );
  } else {
    parts.push('\n## Your task\nReturn the JSON array of test scenarios now.');
  }

  return { system, user: parts.join('\n') };
}
