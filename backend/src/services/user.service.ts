/**
 * Business logic for user administration: listing users and changing a user's
 * global role. All entry points assume the caller already holds the USER_MANAGE
 * permission (enforced by the route middleware); the data-dependent safety rules
 * (no self-edit, keep at least one super admin) are delegated to the pure engine
 * in ../domain/userManagement.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError } from '../middleware/errorHandler';
import { Role } from '../domain/permissions';
import { canChangeRole } from '../domain/userManagement';

/** Public, safe representation of a user (never exposes the password hash). */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

/** Columns selected for any user response — deliberately omits `passwordHash`. */
const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Lists all users, ordered by creation time (oldest first). Password hashes are
 * never selected.
 */
export async function listUsers(): Promise<PublicUser[]> {
  return prisma.user.findMany({
    select: PUBLIC_USER_SELECT,
    orderBy: { createdAt: 'asc' },
  }) as Promise<PublicUser[]>;
}

/**
 * Fetches a single user by id.
 * @throws {AppError} 404 if no such user exists.
 */
export async function getUser(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({
    where: { id },
    select: PUBLIC_USER_SELECT,
  });
  if (!user) {
    throw new AppError('User not found', 404);
  }
  return user as PublicUser;
}

/**
 * Changes a user's global role after validating the safety rules.
 *
 * @param actorId - Id of the administrator performing the change.
 * @param targetId - Id of the user being modified.
 * @param newRole - The role to assign.
 * @returns The updated public user.
 * @throws {AppError} 404 if the target is missing, 409 if the change would
 *   violate a safety rule (self-edit or removing the last super admin).
 */
export async function updateUserRole(
  actorId: string,
  targetId: string,
  newRole: Role,
): Promise<PublicUser> {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true },
  });
  if (!target) {
    throw new AppError('User not found', 404);
  }

  const demotingSuperAdmin = target.role === 'SUPER_ADMIN' && newRole !== 'SUPER_ADMIN';

  // Fast path: no last-super-admin invariant at stake, so a count is irrelevant.
  // canChangeRole still enforces the data-independent rules (e.g. no self-edit).
  if (!demotingSuperAdmin) {
    const decision = canChangeRole(
      actorId,
      { id: target.id, role: target.role as Role },
      newRole,
      Number.POSITIVE_INFINITY,
    );
    if (!decision.allowed) {
      throw new AppError(decision.reason ?? 'Role change is not permitted', 409);
    }
    return prisma.user.update({
      where: { id: targetId },
      data: { role: newRole },
      select: PUBLIC_USER_SELECT,
    }) as Promise<PublicUser>;
  }

  // Demoting a super admin: count + decision + update must be atomic, otherwise
  // two concurrent demotes can each see count > 1 and together drop it to zero
  // (lockout). A Serializable transaction makes the conflicting reads/writes
  // collide so one is aborted (P2034) rather than both committing.
  try {
    return (await prisma.$transaction(
      async (tx) => {
        const superAdminCount = await tx.user.count({ where: { role: 'SUPER_ADMIN' } });
        const decision = canChangeRole(
          actorId,
          { id: target.id, role: target.role as Role },
          newRole,
          superAdminCount,
        );
        if (!decision.allowed) {
          throw new AppError(decision.reason ?? 'Role change is not permitted', 409);
        }
        return tx.user.update({
          where: { id: targetId },
          data: { role: newRole },
          select: PUBLIC_USER_SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )) as PublicUser;
  } catch (err) {
    // A serialization failure means a concurrent demote raced us; ask to retry
    // rather than risk an inconsistent decision.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new AppError('Concurrent role change conflict; please retry', 409);
    }
    throw err;
  }
}
