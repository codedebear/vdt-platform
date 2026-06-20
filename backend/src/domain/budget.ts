/**
 * Pure helpers for per-project AI cost budgets.
 *
 * A project's `budgetUsd` is its lifetime cap (null = unlimited) and `spentUsd`
 * accumulates the estimated cost of every generation. Enforcement is a hard
 * block: once accumulated spend reaches the cap, further generations are
 * refused. These functions have no I/O so they are trivially unit-testable.
 */

/**
 * The budget a new project starts with, from the configured default.
 * A default of 0 (or negative) means "unlimited", stored as null.
 */
export function initialBudgetUsd(envDefault: number): number | null {
  return envDefault > 0 ? envDefault : null;
}

/**
 * Whether a project with `spentUsd` already spent has exhausted `budgetUsd`.
 * A null budget is unlimited and never exhausted.
 */
export function isBudgetExhausted(spentUsd: number, budgetUsd: number | null): boolean {
  if (budgetUsd === null) return false;
  return spentUsd >= budgetUsd;
}
