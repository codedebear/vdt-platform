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

/** Everything the scenario-draft prompt needs about the QA run. */
export interface QaScenarioPromptContext {
  projectName: string;
  description?: string;
  /** The run's free-form input: an SRS, API spec, endpoint list, or test scope. */
  input?: string;
}

/**
 * Builds the system + user prompt that asks Claude to propose UAT test scenarios
 * from the supplied specification/context. The model must return ONLY a JSON
 * array (no prose, no Markdown fences) of objects shaped:
 *   { "topic": string, "testName": string, "system"?: string, "remark"?: string }
 * matching the UATR "Detail Test Scenario Summary" columns (Topic, Test Name,
 * System, Remark). Steps are NOT requested here — they are a later stage.
 */
export function buildScenarioPrompt(ctx: QaScenarioPromptContext): BuiltQaPrompt {
  const system = [
    'You are the QA test designer of an automated QA team at Code De Bear, a Thai IT',
    'solutions provider. From the provided specification and context, propose a thorough',
    'set of black-box User Acceptance Test (UAT) scenarios for the system under test.',
    'Cover the main success paths, validation and error cases, and important edge cases.',
    'Group related scenarios under a shared "topic".',
    'Return ONLY a JSON array — no prose, no explanation, no Markdown code fences.',
    'Each array element must be an object with exactly these keys:',
    '"topic" (string, the group this scenario belongs to),',
    '"testName" (string, a concise description of what this scenario validates),',
    '"system" (string, optional — the component or module under test, e.g. "Customer Portal"),',
    '"remark" (string, optional — any note such as preconditions or test data).',
    'Do NOT include test steps or expected results; those are produced in a later stage.',
    'Do NOT number the scenarios; ordering is assigned by the platform.',
  ].join(' ');

  const parts: string[] = [];
  parts.push(`# Project: ${ctx.projectName}`);
  if (ctx.description && ctx.description.trim().length > 0) {
    parts.push(`Description: ${ctx.description.trim()}`);
  }
  if (ctx.input && ctx.input.trim().length > 0) {
    parts.push(`\n## Specification / context to derive scenarios from\n${ctx.input.trim()}`);
  }
  parts.push('\n## Your task\nReturn the JSON array of test scenarios now.');

  return { system, user: parts.join('\n') };
}
