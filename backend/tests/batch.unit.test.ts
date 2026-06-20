/**
 * Unit tests for the pure batch-workflow domain (status mapping).
 */
import {
  isBatchEnded,
  outcomeForResultType,
  missingResultOutcome,
} from '../src/domain/batch';

describe('isBatchEnded', () => {
  it('is true only for an ended batch', () => {
    expect(isBatchEnded('ended')).toBe(true);
    expect(isBatchEnded('in_progress')).toBe(false);
    expect(isBatchEnded('canceling')).toBe(false);
  });
});

describe('outcomeForResultType', () => {
  it('maps a succeeded result to AWAITING_REVIEW (review gate, like sync)', () => {
    expect(outcomeForResultType('succeeded')).toEqual({
      status: 'AWAITING_REVIEW',
      succeeded: true,
    });
  });

  it('maps every non-success terminal type to FAILED with a reason', () => {
    for (const type of ['errored', 'canceled', 'expired'] as const) {
      const o = outcomeForResultType(type);
      expect(o.status).toBe('FAILED');
      expect(o.succeeded).toBe(false);
      expect(typeof o.reason).toBe('string');
      expect(o.reason?.length).toBeGreaterThan(0);
    }
  });
});

describe('missingResultOutcome', () => {
  it('fails the run so it never stays stuck in QUEUED', () => {
    const o = missingResultOutcome();
    expect(o.status).toBe('FAILED');
    expect(o.succeeded).toBe(false);
    expect(o.reason).toMatch(/no matching result/i);
  });
});
