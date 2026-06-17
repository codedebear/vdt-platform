/**
 * Pure authorization (RBAC) engine for VDT Platform.
 *
 * Defines the global roles, the actions a request may attempt, and the rules
 * mapping one to the other. Like ../domain/workflow this module has no database
 * or HTTP dependency, so it can be unit-tested in isolation and reused by the
 * middleware and service layers as the single source of truth for "who may do
 * what".
 *
 * The `Role` string-literal union intentionally mirrors the Prisma `Role` enum
 * of the same name; Prisma generates identical string values, so the two are
 * interchangeable at runtime.
 */
import { PhaseType } from './workflow';

export type Role = 'SUPER_ADMIN' | 'PROJECT_OWNER' | 'BA' | 'SA' | 'QA' | 'OPERATION';

/** Discrete, checkable operations a user may attempt. */
export type Action =
  | 'PROJECT_CREATE'
  | 'PROJECT_VIEW'
  | 'PHASE_START'
  | 'PHASE_SUBMIT'
  | 'PHASE_REVIEW'
  | 'USER_MANAGE';

/**
 * Extra facts a permission decision may depend on:
 * - `phaseType`: which phase a PHASE_START / PHASE_SUBMIT action targets.
 * - `isProjectOwner`: whether the acting user owns the project in question
 *   (required for PROJECT_OWNER to review/approve).
 */
export interface PermissionContext {
  phaseType?: PhaseType;
  isProjectOwner?: boolean;
}

/**
 * The single "worker" role responsible for running each phase type. A user with
 * this role (or SUPER_ADMIN) may start and submit that phase. Review/approval of
 * the phase is a separate action handled by the project owner.
 */
export const PHASE_WORKER_ROLE: Record<PhaseType, Role> = {
  PLANNER: 'BA',
  DEV: 'SA',
  CODE_REVIEW: 'SA',
  QA: 'QA',
  DOCS: 'OPERATION',
};

/**
 * Decides whether `role` may perform `action` given optional `ctx`.
 *
 * Rules:
 * - SUPER_ADMIN may do anything.
 * - PROJECT_CREATE: PROJECT_OWNER.
 * - PROJECT_VIEW: any authenticated role.
 * - PHASE_START / PHASE_SUBMIT: the worker role mapped to `ctx.phaseType`.
 * - PHASE_REVIEW: PROJECT_OWNER, and only for a project they own
 *   (`ctx.isProjectOwner === true`).
 * - USER_MANAGE: SUPER_ADMIN only (covered by the blanket rule above).
 */
export function can(role: Role, action: Action, ctx: PermissionContext = {}): boolean {
  if (role === 'SUPER_ADMIN') {
    return true;
  }

  switch (action) {
    case 'PROJECT_CREATE':
      return role === 'PROJECT_OWNER';

    case 'PROJECT_VIEW':
      return true;

    case 'PHASE_START':
    case 'PHASE_SUBMIT':
      return ctx.phaseType !== undefined && PHASE_WORKER_ROLE[ctx.phaseType] === role;

    case 'PHASE_REVIEW':
      return role === 'PROJECT_OWNER' && ctx.isProjectOwner === true;

    case 'USER_MANAGE':
      return false;

    default:
      return false;
  }
}
