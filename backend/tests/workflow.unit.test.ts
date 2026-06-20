/**
 * Unit tests for the pure workflow engine. No database or HTTP layer involved.
 */
import {
  PHASE_SEQUENCE,
  canStartPhase,
  getNextPhase,
  getStartablePhases,
  isPhaseInTrack,
  isRepeatable,
  nextRunNumber,
  resolveReview,
  ExecutionSummary,
} from '../src/domain/workflow';

/** Convenience builder for an execution summary. */
function exec(
  phaseType: ExecutionSummary['phaseType'],
  status: ExecutionSummary['status'],
  runNumber = 1,
): ExecutionSummary {
  return { phaseType, status, runNumber };
}

describe('phase sequences', () => {
  it('defines the full SDLC order', () => {
    expect(PHASE_SEQUENCE.FULL_SDLC).toEqual([
      'PLANNER',
      'DEV',
      'QA',
      'CODE_REVIEW',
      'DOCS',
    ]);
  });

  it('defines the lightweight QA-only order', () => {
    expect(PHASE_SEQUENCE.QA_ONLY).toEqual(['PLANNER', 'QA']);
  });

  it('reports phase membership per track', () => {
    expect(isPhaseInTrack('QA_ONLY', 'PLANNER')).toBe(true);
    expect(isPhaseInTrack('QA_ONLY', 'QA')).toBe(true);
    expect(isPhaseInTrack('QA_ONLY', 'DEV')).toBe(false);
    expect(isPhaseInTrack('FULL_SDLC', 'DOCS')).toBe(true);
  });

  it('marks only QA as repeatable', () => {
    expect(isRepeatable('FULL_SDLC', 'QA')).toBe(true);
    expect(isRepeatable('FULL_SDLC', 'DEV')).toBe(false);
    expect(isRepeatable('QA_ONLY', 'QA')).toBe(true);
    expect(isRepeatable('QA_ONLY', 'PLANNER')).toBe(false);
  });
});

describe('getNextPhase', () => {
  it('starts at PLANNER for an empty project', () => {
    expect(getNextPhase('FULL_SDLC', [])).toBe('PLANNER');
  });

  it('advances past approved phases', () => {
    const execs = [exec('PLANNER', 'APPROVED')];
    expect(getNextPhase('FULL_SDLC', execs)).toBe('DEV');
  });

  it('ignores non-approved runs when advancing', () => {
    const execs = [exec('PLANNER', 'APPROVED'), exec('DEV', 'AWAITING_REVIEW')];
    expect(getNextPhase('FULL_SDLC', execs)).toBe('DEV');
  });

  it('returns null when every phase is approved', () => {
    const execs = PHASE_SEQUENCE.FULL_SDLC.map((p) => exec(p, 'APPROVED'));
    expect(getNextPhase('FULL_SDLC', execs)).toBeNull();
  });

  it('follows the QA_ONLY sequence', () => {
    expect(getNextPhase('QA_ONLY', [])).toBe('PLANNER');
    expect(getNextPhase('QA_ONLY', [exec('PLANNER', 'APPROVED')])).toBe('QA');
  });
});

describe('nextRunNumber', () => {
  it('is 1 for the first run of a phase', () => {
    expect(nextRunNumber([], 'QA')).toBe(1);
    expect(nextRunNumber([exec('PLANNER', 'APPROVED')], 'QA')).toBe(1);
  });

  it('increments from the highest existing run of that phase', () => {
    const execs = [exec('QA', 'APPROVED', 1), exec('QA', 'FAILED', 2)];
    expect(nextRunNumber(execs, 'QA')).toBe(3);
  });
});

describe('canStartPhase', () => {
  it('rejects a phase not in the track', () => {
    const decision = canStartPhase('QA_ONLY', 'DEV', []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not part of the QA_ONLY track/);
  });

  it('allows the first phase of a fresh project', () => {
    expect(canStartPhase('FULL_SDLC', 'PLANNER', []).allowed).toBe(true);
  });

  it('blocks a phase whose prerequisite is not approved', () => {
    const decision = canStartPhase('FULL_SDLC', 'DEV', []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/PLANNER must be approved/);
  });

  it('allows a phase once its prerequisite is approved', () => {
    const execs = [exec('PLANNER', 'APPROVED')];
    expect(canStartPhase('FULL_SDLC', 'DEV', execs).allowed).toBe(true);
  });

  it('blocks starting a phase that already has an open run', () => {
    const execs = [exec('PLANNER', 'AWAITING_REVIEW')];
    const decision = canStartPhase('FULL_SDLC', 'PLANNER', execs);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/open PLANNER run already exists/);
  });

  it('blocks re-running a non-repeatable phase after approval', () => {
    const execs = [exec('PLANNER', 'APPROVED')];
    const decision = canStartPhase('FULL_SDLC', 'PLANNER', execs);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/already approved and cannot be repeated/);
  });

  it('allows repeatable QA to re-run after a prior approved QA', () => {
    const execs = [
      exec('PLANNER', 'APPROVED'),
      exec('DEV', 'APPROVED'),
      exec('QA', 'APPROVED', 1),
    ];
    expect(canStartPhase('FULL_SDLC', 'QA', execs).allowed).toBe(true);
  });

  it('allows repeatable QA re-runs on the QA_ONLY track', () => {
    const execs = [exec('PLANNER', 'APPROVED'), exec('QA', 'APPROVED', 1)];
    expect(canStartPhase('QA_ONLY', 'QA', execs).allowed).toBe(true);
  });

  it('still blocks a repeatable phase if it has an open run', () => {
    const execs = [
      exec('PLANNER', 'APPROVED'),
      exec('QA', 'IN_PROGRESS', 1),
    ];
    expect(canStartPhase('QA_ONLY', 'QA', execs).allowed).toBe(false);
  });
});

describe('resolveReview', () => {
  it('approves an awaiting-review run', () => {
    expect(resolveReview('AWAITING_REVIEW', 'APPROVE')).toBe('APPROVED');
  });

  it('requests changes on an awaiting-review run', () => {
    expect(resolveReview('AWAITING_REVIEW', 'REQUEST_CHANGES')).toBe('CHANGES_REQUESTED');
  });

  it('throws when the run is not awaiting review', () => {
    expect(() => resolveReview('IN_PROGRESS', 'APPROVE')).toThrow(/expected AWAITING_REVIEW/);
    expect(() => resolveReview('APPROVED', 'APPROVE')).toThrow();
  });
});


describe('getStartablePhases', () => {
  it('offers only the first phase on an empty FULL_SDLC project', () => {
    expect(getStartablePhases('FULL_SDLC', [])).toEqual(['PLANNER']);
  });

  it('advances to the next phase once the prior is approved', () => {
    const execs = [exec('PLANNER', 'APPROVED')];
    expect(getStartablePhases('FULL_SDLC', execs)).toEqual(['DEV']);
  });

  it('excludes a phase that has an open (incl. QUEUED) run', () => {
    const execs = [exec('PLANNER', 'QUEUED')];
    expect(getStartablePhases('FULL_SDLC', execs)).toEqual([]);
  });

  it('re-offers an approved repeatable phase (QA) with no open run', () => {
    const execs = [
      exec('PLANNER', 'APPROVED'),
      exec('DEV', 'APPROVED'),
      exec('QA', 'APPROVED'),
      exec('CODE_REVIEW', 'APPROVED'),
    ];
    // QA is repeatable; the next unapproved phase (DOCS) is also startable.
    const startable = getStartablePhases('FULL_SDLC', execs);
    expect(startable).toContain('QA');
    expect(startable).toContain('DOCS');
  });
});
