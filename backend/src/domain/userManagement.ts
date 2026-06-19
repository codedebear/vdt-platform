/**
 * Pure decision logic for user administration (role changes).
 *
 * Like ../domain/permissions and ../domain/workflow, this module is free of any
 * database or HTTP dependency so it can be unit-tested in isolation and used as
 * the single source of truth for the safety rules that protect against an
 * administrator locking everyone out of user management.
 *
 * The coarse "may this role manage users at all?" check lives in
 * ../domain/permissions (`USER_MANAGE`, SUPER_ADMIN only). This module adds the
 * finer, data-dependent rules that the service layer enforces once it knows the
 * target user and how many super admins remain.
 */
import { Role } from './permissions';

/** The minimal view of the user whose role is being changed. */
export interface RoleChangeTarget {
  id: string;
  role: Role;
}

/** Outcome of a role-change safety check. */
export interface RoleChangeDecision {
  allowed: boolean;
  /** Human-readable reason when `allowed` is false. */
  reason?: string;
}

/**
 * Decides whether `actorId` may change `target`'s role to `newRole`.
 *
 * The caller is already known to hold the USER_MANAGE permission (SUPER_ADMIN);
 * these rules guard against destructive edge cases:
 *  - An admin may not change their **own** role (prevents accidental
 *    self-demotion / self-lockout; role changes go through another admin).
 *  - The **last** remaining SUPER_ADMIN may not be demoted (prevents locking
 *    every user out of user management).
 *
 * Re-assigning a user to the role they already hold is allowed (idempotent).
 *
 * @param actorId - Id of the administrator performing the change.
 * @param target - The user being modified (current id + role).
 * @param newRole - The role to assign.
 * @param superAdminCount - Current number of users with the SUPER_ADMIN role.
 * @returns Whether the change is permitted, with a reason if not.
 */
export function canChangeRole(
  actorId: string,
  target: RoleChangeTarget,
  newRole: Role,
  superAdminCount: number,
): RoleChangeDecision {
  if (target.id === actorId) {
    return {
      allowed: false,
      reason: 'You cannot change your own role; ask another super admin to do it',
    };
  }

  const isDemotingASuperAdmin = target.role === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN';
  if (isDemotingASuperAdmin && superAdminCount <= 1) {
    return {
      allowed: false,
      reason: 'Cannot demote the last super admin; promote another user first',
    };
  }

  return { allowed: true };
}
