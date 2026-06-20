/**
 * Unit tests for the pure pricing domain (cost estimation + price resolution).
 */
import {
  approxTokensFromChars,
  BATCH_PRICE_FACTOR,
  estimateCostUsd,
  resolveModelPrice,
} from '../src/domain/pricing';

describe('approxTokensFromChars', () => {
  it('over-estimates at ~3 chars/token and never goes negative', () => {
    expect(approxTokensFromChars(300)).toBe(100);
    expect(approxTokensFromChars(301)).toBe(101); // rounds up
    expect(approxTokensFromChars(0)).toBe(0);
    expect(approxTokensFromChars(-50)).toBe(0);
  });
});

describe('resolveModelPrice', () => {
  it('matches model families by substring', () => {
    expect(resolveModelPrice('claude-opus-4-8')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(resolveModelPrice('claude-sonnet-4-6')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(resolveModelPrice('claude-haiku-4-5')).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it('falls back to the mid-tier rate for unknown models', () => {
    expect(resolveModelPrice('some-future-model')).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it('lets a positive override win per side, ignoring zero/negative', () => {
    const p = resolveModelPrice('claude-haiku-4-5', { inputPerMTok: 2, outputPerMTok: 0 });
    expect(p).toEqual({ inputPerMTok: 2, outputPerMTok: 5 });
  });
});

describe('estimateCostUsd', () => {
  it('computes input+output cost per million tokens', () => {
    // Sonnet: 1M in * $3 + 1M out * $15 = $18
    expect(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
    // Opus: 50k in * $5/M + 15k out * $25/M = 0.25 + 0.375 = 0.625
    expect(estimateCostUsd('claude-opus-4-8', 50_000, 15_000)).toBeCloseTo(0.625, 6);
  });

  it('treats null/undefined token counts as zero (never NaN)', () => {
    expect(estimateCostUsd('claude-sonnet-4-6', null, null)).toBe(0);
    expect(estimateCostUsd('claude-sonnet-4-6', undefined, 1_000_000)).toBeCloseTo(15, 6);
  });

  it('honours overrides', () => {
    expect(
      estimateCostUsd('claude-sonnet-4-6', 1_000_000, 0, { inputPerMTok: 10 }),
    ).toBeCloseTo(10, 6);
  });

  it('applies a discount factor (batch = half price) and clamps it at zero', () => {
    // Sonnet $18 full price at 1M in + 1M out; batch factor halves it.
    expect(
      estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, undefined, BATCH_PRICE_FACTOR),
    ).toBeCloseTo(9, 6);
    expect(BATCH_PRICE_FACTOR).toBe(0.5);
    // A non-positive factor never produces a negative cost.
    expect(estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000, undefined, -1)).toBe(0);
  });
});
