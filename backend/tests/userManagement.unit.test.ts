/**
 * Unit tests for the pure user-administration safety logic.
 */
import { canChangeRole, RoleChangeTarget } from '../src/domain/userManagement';

const ACTOR = 'actor-1';

function target(id: string, role: RoleChangeTarget['role']): RoleChangeTarget {
  return { id, role };
}

describe('canChangeRole', () => {
  it('allows promoting a normal user to a worker role', () => {
    const d = canChangeRole(ACTOR, target('u2', 'OPERATION'), 'QA', 3);
    expect(d.allowed).toBe(true);
  });

  it('allows promoting a user to SUPER_ADMIN', () => {
    const d = canChangeRole(ACTOR, target('u2', 'OPERATION'), 'SUPER_ADMIN', 1);
    expect(d.allowed).toBe(true);
  });

  it('is idempotent: assigning the same role is allowed', () => {
    const d = canChangeRole(ACTOR, target('u2', 'QA'), 'QA', 2);
    expect(d.allowed).toBe(true);
  });

  it('forbids an admin from changing their own role', () => {
    const d = canChangeRole(ACTOR, target(ACTOR, 'SUPER_ADMIN'), 'OPERATION', 5);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/your own role/i);
  });

  it('forbids demoting the last super admin', () => {
    const d = canChangeRole(ACTOR, target('u2', 'SUPER_ADMIN'), 'PROJECT_OWNER', 1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/last super admin/i);
  });

  it('allows demoting a super admin when another remains', () => {
    const d = canChangeRole(ACTOR, target('u2', 'SUPER_ADMIN'), 'PROJECT_OWNER', 2);
    expect(d.allowed).toBe(true);
  });

  it('allows keeping a sole super admin as SUPER_ADMIN (no demotion)', () => {
    const d = canChangeRole(ACTOR, target('u2', 'SUPER_ADMIN'), 'SUPER_ADMIN', 1);
    expect(d.allowed).toBe(true);
  });
});
