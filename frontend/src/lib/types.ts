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
  | 'FAILED';

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
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  track: Track;
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
