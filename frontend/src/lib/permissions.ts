/**
 * Frontend mirror of the backend RBAC engine (`backend/src/domain/permissions.ts`).
 *
 * Used only to decide which action buttons to show — the backend re-checks every
 * request and remains the source of truth, so this never grants access, it only
 * hides controls the user could not use anyway (keeps the UI honest and quiet).
 */
import type { PhaseType, Role } from './types';

/** Discrete operations the UI may offer. Mirrors the backend `Action` union. */
export type Action =
  | 'PROJECT_CREATE'
  | 'PHASE_START'
  | 'PHASE_SUBMIT'
  | 'PHASE_REVIEW'
  | 'USER_MANAGE';

export interface PermissionContext {
  phaseType?: PhaseType;
  /** Whether the acting user owns the project in question. */
  isProjectOwner?: boolean;
}

/** The single worker role responsible for running each phase type. */
export const PHASE_WORKER_ROLE: Record<PhaseType, Role> = {
  PLANNER: 'BA',
  DEV: 'SA',
  CODE_REVIEW: 'SA',
  QA: 'QA',
  DOCS: 'OPERATION',
};

/**
 * Whether `role` may perform `action` given `ctx`. Identical rule set to the
 * backend's `can()`:
 * - SUPER_ADMIN may do anything.
 * - PROJECT_CREATE: PROJECT_OWNER.
 * - PHASE_START / PHASE_SUBMIT: the worker role mapped to `ctx.phaseType`.
 * - PHASE_REVIEW: PROJECT_OWNER, only for a project they own.
 * - USER_MANAGE: SUPER_ADMIN only (covered by the blanket rule).
 */
export function can(role: Role, action: Action, ctx: PermissionContext = {}): boolean {
  if (role === 'SUPER_ADMIN') return true;

  switch (action) {
    case 'PROJECT_CREATE':
      return role === 'PROJECT_OWNER';

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
