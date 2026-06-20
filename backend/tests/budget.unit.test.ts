/**
 * Unit tests for the pure budget domain (initial budget + exhaustion).
 */
import { initialBudgetUsd, isBudgetExhausted } from '../src/domain/budget';

describe('initialBudgetUsd', () => {
  it('returns null (unlimited) when the default is 0 or negative', () => {
    expect(initialBudgetUsd(0)).toBeNull();
    expect(initialBudgetUsd(-5)).toBeNull();
  });

  it('returns the default when positive', () => {
    expect(initialBudgetUsd(25)).toBe(25);
  });
});

describe('isBudgetExhausted', () => {
  it('is never exhausted for an unlimited (null) budget', () => {
    expect(isBudgetExhausted(1_000_000, null)).toBe(false);
  });

  it('blocks once spend reaches the cap', () => {
    expect(isBudgetExhausted(9.99, 10)).toBe(false);
    expect(isBudgetExhausted(10, 10)).toBe(true);
    expect(isBudgetExhausted(10.01, 10)).toBe(true);
  });
});
