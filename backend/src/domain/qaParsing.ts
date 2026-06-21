/**
 * Pure parsing of Claude's structured QA output into validated draft objects
 * (QAX-2). Kept free of I/O so it can be unit-tested directly; the service layer
 * catches the thrown Error and maps it to an HTTP error.
 *
 * The model is asked for raw JSON, but in practice it sometimes wraps the array
 * in a ```json fence or adds a stray sentence. {@link extractJsonArray} is
 * deliberately tolerant: it strips a surrounding code fence and falls back to the
 * outermost [...] slice before parsing, so a minor formatting slip does not fail
 * the whole generation.
 */
import { z } from 'zod';
import { artifactSpecSchema, ArtifactSpec } from './qaArtifact';

/** A drafted test scenario — one block in the UATR "Detail" sheet. */
export interface ScenarioDraft {
  topic: string;
  testName: string;
  system?: string;
  remark?: string;
}

/** Error thrown when the model output cannot be parsed/validated. The service
 * maps this to a 502 (the upstream produced an unusable response). */
export class QaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QaParseError';
  }
}

const scenarioSchema = z
  .object({
    topic: z.string().trim().min(1, 'topic is required'),
    testName: z.string().trim().min(1, 'testName is required'),
    system: z.string().trim().min(1).optional(),
    remark: z.string().trim().min(1).optional(),
  })
  .strip();

const scenarioArraySchema = z.array(scenarioSchema);

/**
 * Pulls a JSON array out of a model response that may be wrapped in a Markdown
 * code fence or padded with prose. Returns the raw JSON string ready for
 * `JSON.parse`.
 * @throws {QaParseError} if no array-looking JSON can be located.
 */
export function extractJsonArray(text: string): string {
  let s = text.trim();

  // Strip a leading/trailing Markdown code fence (```json ... ``` or ``` ... ```).
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    s = fence[1].trim();
  }

  // If there is still surrounding prose, take the outermost [...] slice.
  if (!s.startsWith('[')) {
    const start = s.indexOf('[');
    const end = s.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) {
      throw new QaParseError('No JSON array found in the model response');
    }
    s = s.slice(start, end + 1);
  }
  return s;
}

/**
 * Parses and validates the model's scenario output into {@link ScenarioDraft}s.
 * @throws {QaParseError} if the JSON is malformed, not an array, empty, or any
 *   element fails validation.
 */
export function parseScenarioDrafts(text: string): ScenarioDraft[] {
  const json = extractJsonArray(text);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new QaParseError(
      `Model scenario output was not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = scenarioArraySchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.errors
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('; ');
    throw new QaParseError(`Model scenario output failed validation: ${detail}`);
  }
  if (result.data.length === 0) {
    throw new QaParseError('Model returned an empty scenario list');
  }

  return result.data.map((s) => ({
    topic: s.topic,
    testName: s.testName,
    ...(s.system ? { system: s.system } : {}),
    ...(s.remark ? { remark: s.remark } : {}),
  }));
}

/** One step of a scenario as drafted by the model. */
export interface StepDraft {
  stepName: string;
  expectedResult: string;
}

/** The steps the model produced for one scenario, keyed by the scenario's `no`. */
export interface ScenarioStepsDraft {
  no: number;
  steps: StepDraft[];
}

const stepSchema = z
  .object({
    stepName: z.string().trim().min(1, 'stepName is required'),
    expectedResult: z.string().trim().min(1, 'expectedResult is required'),
  })
  .strip();

const scenarioStepsSchema = z
  .object({
    no: z.number().int().positive('no must be a positive scenario number'),
    steps: z.array(stepSchema).min(1, 'each scenario needs at least one step'),
  })
  .strip();

const scenarioStepsArraySchema = z.array(scenarioStepsSchema);

/**
 * Parses and validates the model's step output into {@link ScenarioStepsDraft}s.
 * The caller maps each `no` back to a scenario.
 * @throws {QaParseError} if the JSON is malformed, not an array, empty, or any
 *   element fails validation.
 */
export function parseScenarioStepsDrafts(text: string): ScenarioStepsDraft[] {
  const json = extractJsonArray(text);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new QaParseError(`Model step output was not valid JSON: ${(err as Error).message}`);
  }

  const result = scenarioStepsArraySchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.errors
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('; ');
    throw new QaParseError(`Model step output failed validation: ${detail}`);
  }
  if (result.data.length === 0) {
    throw new QaParseError('Model returned steps for no scenarios');
  }

  return result.data.map((g) => ({
    no: g.no,
    steps: g.steps.map((s) => ({ stepName: s.stepName, expectedResult: s.expectedResult })),
  }));
}

/** The compiled artifact for one step, keyed back to its (scenario no, step order). */
export interface CompiledStepArtifact {
  no: number;
  order: number;
  artifact: ArtifactSpec;
}

const compiledArtifactSchema = z
  .object({
    no: z.number().int().positive('no must be a positive scenario number'),
    order: z.number().int().positive('order must be a positive step number'),
    artifact: artifactSpecSchema,
  })
  .strip();

const compiledArtifactArraySchema = z.array(compiledArtifactSchema);

/**
 * Parses and validates the model's compile output: one entry per step, each
 * carrying its (scenario `no`, step `order`) and a fully-validated artifactSpec.
 * The caller maps each entry back to a TestStep by (no, order).
 * @throws {QaParseError} if the JSON is malformed, not an array, empty, or any
 *   artifact fails the contract validation.
 */
export function parseCompiledArtifacts(text: string): CompiledStepArtifact[] {
  const json = extractJsonArray(text);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new QaParseError(`Model compile output was not valid JSON: ${(err as Error).message}`);
  }

  const result = compiledArtifactArraySchema.safeParse(data);
  if (!result.success) {
    const detail = result.error.errors
      .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('; ');
    throw new QaParseError(`Model compile output failed validation: ${detail}`);
  }
  if (result.data.length === 0) {
    throw new QaParseError('Model compiled no steps');
  }

  return result.data.map((e) => ({ no: e.no, order: e.order, artifact: e.artifact }));
}
