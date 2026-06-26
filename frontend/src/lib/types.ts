/**
 * Shared domain types mirrored from the backend API. Kept as string-literal
 * unions to match the Prisma enums exactly (same string values).
 */

export type Role =
  | 'SUPER_ADMIN'
  | 'PROJECT_OWNER'
  | 'BA'
  | 'SA'
  | 'QA'
  | 'OPERATION';

export type Track = 'FULL_SDLC' | 'QA_ONLY';

export type ProjectStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';

export type PhaseType = 'PLANNER' | 'DEV' | 'QA' | 'CODE_REVIEW' | 'DOCS';

export type PhaseStatus =
  | 'IN_PROGRESS'
  | 'AWAITING_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'FAILED'
  /** A batch-mode generation is in flight on the Anthropic Batch API; the
   *  backend poller resolves it to AWAITING_REVIEW or FAILED. */
  | 'QUEUED';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface PhaseExecution {
  id: string;
  projectId: string;
  phaseType: PhaseType;
  runNumber: number;
  status: PhaseStatus;
  input: string | null;
  output: string | null;
  reviewNote: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generationCount: number;
  /** Anthropic Batch API id while a batch generation is QUEUED; null otherwise. */
  batchId: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present on the project-detail response; metadata only, never bytes. */
  attachments?: AttachmentMeta[];
}

/** Core project fields, as returned by POST /api/projects (create). */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  track: Track;
  status: ProjectStatus;
  ownerId: string;
  /** Lifetime AI budget cap in USD; null = unlimited. */
  budgetUsd: number | null;
  /** Accumulated estimated AI spend in USD. */
  spentUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** Shape returned by GET /api/projects (list) — adds an execution count. */
export interface ProjectListItem extends Project {
  _count: { executions: number };
}

/** Shape returned by GET /api/projects/:id — executions + suggested next phase. */
export interface ProjectDetail extends Project {
  executions: PhaseExecution[];
  nextPhase: PhaseType | null;
  /** Phases the engine says may be started now (server-computed; the UI no
   *  longer re-implements the start rules — it just gates these by role). */
  startablePhases: PhaseType[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  track: Track;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}

/**
 * Public metadata for a phase-run attachment, as returned by the
 * /api/phases/:id/attachments endpoints. Never includes the file bytes.
 */
export interface AttachmentMeta {
  id: string;
  executionId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

/** Effective attachment limits + accepted types, as served by GET /api/config. */
export interface AttachmentConfig {
  maxFileMb: number;
  maxPerRun: number;
  maxTotalMb: number;
  acceptedExtensions: string[];
}

/** Public runtime config served by GET /api/config. */
export interface AppConfig {
  attachments: AttachmentConfig;
}

/** A user as returned by the admin /api/users endpoints (no password hash). */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

/** Human review decision on a phase run. */
export type ReviewAction = 'APPROVE' | 'REQUEST_CHANGES';

/**
 * How a phase output is generated:
 * - `sync`  — immediate, full price, returns AWAITING_REVIEW.
 * - `batch` — Anthropic Batch API, ~50% cheaper, async (run goes QUEUED).
 */
export type GenerationMode = 'sync' | 'batch';

/** Body for POST /api/projects/:id/phases — start a new run of a phase. */
export interface StartPhaseInput {
  phaseType: PhaseType;
  input?: string;
}

/** Body for POST /api/phases/:id/review. */
export interface ReviewPhaseInput {
  action: ReviewAction;
  note?: string;
}

/* -------------------------------------------------------------------------- */
/* Staged QA execution (QAX-2..5)                                              */
/* -------------------------------------------------------------------------- */

/** The stages a single QA run (TestRun) moves through, in order. */
export type QaStage =
  | 'SCENARIO_DRAFT'
  | 'STEPS_DRAFT'
  | 'COMPILED'
  | 'EXECUTING'
  | 'RESULTS_REVIEW'
  | 'EXPORTED';

/** Per-step execution status (UATR Detail "Status" column). */
export type TestStatus = 'NOT_START' | 'IN_PROGRESS' | 'PASS' | 'FAIL' | 'SKIPPED';

/** Rolled-up result for a scenario or whole run (UATR Summary "Result"). */
export type ScenarioResult = 'PASS' | 'FAIL' | 'IN_PROGRESS' | 'NOT_COMPLETE' | 'NO_RUN';

/** What kind of executable a compiled step produces. */
export type TestArtifactType = 'HTTP' | 'BROWSER';

/** The request half of a compiled HTTP artifact — shown in the QA evidence panel. */
export interface HttpArtifactRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

/** One executed step's result (evidence bytes are not surfaced to the client). */
export interface TestResult {
  id: string;
  stepId: string;
  status: TestStatus;
  actualResult: string | null;
  evidenceMime: string | null;
  durationMs: number | null;
  executedAt: string | null;
  remark: string | null;
}

export interface TestStep {
  id: string;
  scenarioId: string;
  order: number;
  stepName: string;
  expectedResult: string;
  artifactType: TestArtifactType | null;
  artifactSpec: unknown;
  result: TestResult | null;
}

export interface TestScenario {
  id: string;
  runId: string;
  no: number;
  topic: string;
  testName: string;
  system: string | null;
  remark: string | null;
  result: ScenarioResult | null;
  steps: TestStep[];
}

/** A QA run as returned by GET /api/phases/:id/qa (and every QA mutation). */
export interface TestRun {
  id: string;
  executionId: string;
  stage: QaStage;
  version: string;
  preparedBy: string | null;
  reviewedBy: string | null;
  approvedBy: string | null;
  overallResult: ScenarioResult | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Per-run plaintext test data (IMEI, SO numbers, etc.) set at COMPILED stage. */
  params: Record<string, string> | null;
  scenarios: TestScenario[];
}

/** A project's target execution environment (non-prod only in v1). */
export interface TargetEnvironment {
  id: string;
  projectId: string;
  label: string | null;
  baseUrl: string;
  hostAllowlist: string[];
  isNonProd: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Optional UATR Amendment metadata stamped at results sign-off. */
export interface UatrSignOffInput {
  version?: string;
  preparedBy?: string;
  reviewedBy?: string;
  approvedBy?: string;
}
