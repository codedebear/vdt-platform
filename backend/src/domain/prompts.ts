/**
 * Pure prompt construction for AI phase generation.
 *
 * Builds the system + user messages sent to the Claude API for each phase type,
 * assembling project context and the outputs of previously approved phases. Like
 * ../domain/workflow and ../domain/permissions, this module has no I/O so it can
 * be unit-tested in isolation; the generation service supplies the runtime data.
 */
import { PhaseType, Track } from './workflow';

/** A prior phase's approved output, used as context for the next phase. */
export interface PriorOutput {
  phaseType: PhaseType;
  output: string;
}

/** Everything the prompt builder needs about the run being generated. */
export interface PromptContext {
  projectName: string;
  description?: string;
  track: Track;
  phaseType: PhaseType;
  /** Approved outputs of earlier phases, in chronological order. */
  priorOutputs: PriorOutput[];
  /** Free-form input attached to this run (e.g. an SRS or endpoint list). */
  input?: string;
}

/** The pair of messages handed to the Claude API. */
export interface BuiltPrompt {
  system: string;
  user: string;
}

/** Human-readable label for each phase, used inside prompts. */
const PHASE_LABEL: Record<PhaseType, string> = {
  PLANNER: 'Planner',
  DEV: 'Developer',
  QA: 'QA Engineer',
  CODE_REVIEW: 'Code Reviewer',
  DOCS: 'Technical Writer',
};

/**
 * Per-phase instructions describing the role and the expected deliverable. Kept
 * deliberately concrete so generations are consistent and review-ready.
 */
const PHASE_INSTRUCTIONS: Record<PhaseType, string> = {
  PLANNER: [
    'You are the Planner. Analyse the requirement and produce a structured project plan.',
    'Include: recommended tech stack, a folder structure, a phase/task breakdown table,',
    'risks & open questions, and explicit assumptions. Be concrete and implementation-ready.',
  ].join(' '),
  DEV: [
    'You are the Developer. Implement the approved plan as production-ready code.',
    'Follow TypeScript best practices, output complete files (never elide code), and include',
    'a short summary of files created and how to run them. Do not invent files not needed.',
  ].join(' '),
  QA: [
    'You are the QA Engineer. Write and describe a thorough test plan and results for the work so far:',
    'API/endpoint cases, input validation (valid/invalid/edge), error handling, and integration checks.',
    'Present results as a table with expected vs actual and a pass/fail summary.',
  ].join(' '),
  CODE_REVIEW: [
    'You are the Code Reviewer. Review the implementation for quality, security, and maintainability.',
    'Group findings as Critical / Warning / Minor, include a security checklist, and give a clear verdict.',
    'Suggest fixes; do not rewrite the whole codebase.',
  ].join(' '),
  DOCS: [
    'You are the Technical Writer. Produce complete documentation for the project:',
    'a README (overview, prerequisites, quick start, env vars), an API reference for every endpoint,',
    'and a deployment guide. Write in clear, well-structured Markdown.',
  ].join(' '),
};

/** Short description of what each track is for, to orient the model. */
const TRACK_NOTE: Record<Track, string> = {
  FULL_SDLC: 'This project uses the FULL_SDLC track (Planner → Dev → QA → Code Review → Docs).',
  QA_ONLY:
    'This project uses the QA_ONLY track: the client already has code and wants independent QA. ' +
    'The Planner phase produces a lightweight Test Scope rather than a full build plan.',
};

/**
 * Builds the system + user prompt for generating `ctx.phaseType` output.
 * The system message fixes the role and global rules; the user message carries
 * the project context, prior approved outputs, and the run's own input.
 */
export function buildPrompt(ctx: PromptContext): BuiltPrompt {
  const label = PHASE_LABEL[ctx.phaseType];

  const system = [
    `You are the ${label} agent of an automated software delivery team at Code De Bear,`,
    'a Thai IT solutions provider. Produce a single, complete, review-ready deliverable in',
    'English using Markdown. Be precise and avoid placeholders like "TODO" or "rest of code".',
    PHASE_INSTRUCTIONS[ctx.phaseType],
  ].join(' ');

  const parts: string[] = [];
  parts.push(`# Project: ${ctx.projectName}`);
  if (ctx.description) {
    parts.push(`Description: ${ctx.description}`);
  }
  parts.push(TRACK_NOTE[ctx.track]);

  if (ctx.input && ctx.input.trim().length > 0) {
    parts.push(`\n## Input for this ${label} task\n${ctx.input.trim()}`);
  }

  if (ctx.priorOutputs.length > 0) {
    parts.push('\n## Approved outputs from earlier phases');
    for (const prior of ctx.priorOutputs) {
      parts.push(`\n### ${PHASE_LABEL[prior.phaseType]} output\n${prior.output.trim()}`);
    }
  }

  parts.push(`\n## Your task\nProduce the ${label} deliverable for this project now.`);

  return { system, user: parts.join('\n') };
}
