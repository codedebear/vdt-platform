/**
 * Unit tests for the pure RBAC engine. No database or HTTP layer involved.
 */
import { PHASE_WORKER_ROLE, Role, can } from '../src/domain/permissions';
import { PhaseType } from '../src/domain/workflow';

const ALL_ROLES: Role[] = ['SUPER_ADMIN', 'PROJECT_OWNER', 'BA', 'SA', 'QA', 'OPERATION'];
const ALL_PHASES: PhaseType[] = ['PLANNER', 'DEV', 'QA', 'CODE_REVIEW', 'DOCS'];

describe('SUPER_ADMIN', () => {
  it('may perform every action', () => {
    expect(can('SUPER_ADMIN', 'PROJECT_CREATE')).toBe(true);
    expect(can('SUPER_ADMIN', 'USER_MANAGE')).toBe(true);
    expect(can('SUPER_ADMIN', 'PHASE_REVIEW', { isProjectOwner: false })).toBe(true);
    for (const phase of ALL_PHASES) {
      expect(can('SUPER_ADMIN', 'PHASE_START', { phaseType: phase })).toBe(true);
      expect(can('SUPER_ADMIN', 'PHASE_SUBMIT', { phaseType: phase })).toBe(true);
    }
  });
});

describe('PROJECT_CREATE', () => {
  it('is allowed only for PROJECT_OWNER (and SUPER_ADMIN)', () => {
    expect(can('PROJECT_OWNER', 'PROJECT_CREATE')).toBe(true);
    for (const role of ['BA', 'SA', 'QA', 'OPERATION'] as Role[]) {
      expect(can(role, 'PROJECT_CREATE')).toBe(false);
    }
  });
});

describe('PROJECT_VIEW', () => {
  it('is allowed for every authenticated role', () => {
    for (const role of ALL_ROLES) {
      expect(can(role, 'PROJECT_VIEW')).toBe(true);
    }
  });
});

describe('USER_MANAGE', () => {
  it('is denied to every role except SUPER_ADMIN', () => {
    for (const role of ALL_ROLES.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(can(role, 'USER_MANAGE')).toBe(false);
    }
  });
});

describe('PHASE_START / PHASE_SUBMIT', () => {
  it('allows only the worker role mapped to each phase type', () => {
    for (const phase of ALL_PHASES) {
      const worker = PHASE_WORKER_ROLE[phase];
      for (const role of ALL_ROLES) {
        const expected = role === worker || role === 'SUPER_ADMIN';
        expect(can(role, 'PHASE_START', { phaseType: phase })).toBe(expected);
        expect(can(role, 'PHASE_SUBMIT', { phaseType: phase })).toBe(expected);
      }
    }
  });

  it('maps phases to the agreed worker roles', () => {
    expect(PHASE_WORKER_ROLE).toEqual({
      PLANNER: 'BA',
      DEV: 'SA',
      CODE_REVIEW: 'SA',
      QA: 'QA',
      DOCS: 'OPERATION',
    });
  });

  it('denies a phase action with no phase type in context', () => {
    expect(can('SA', 'PHASE_START')).toBe(false);
  });
});

describe('PHASE_REVIEW', () => {
  it('allows the project owner only for projects they own', () => {
    expect(can('PROJECT_OWNER', 'PHASE_REVIEW', { isProjectOwner: true })).toBe(true);
    expect(can('PROJECT_OWNER', 'PHASE_REVIEW', { isProjectOwner: false })).toBe(false);
  });

  it('denies worker roles regardless of ownership flag', () => {
    for (const role of ['BA', 'SA', 'QA', 'OPERATION'] as Role[]) {
      expect(can(role, 'PHASE_REVIEW', { isProjectOwner: true })).toBe(false);
    }
  });
});
