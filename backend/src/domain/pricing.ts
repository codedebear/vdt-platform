/**
 * Pure, unit-testable estimation of the approximate USD cost of a Claude
 * generation from its token usage.
 *
 * The built-in table holds Anthropic's standard (non-batch) per-million-token
 * prices, matched by model family. Prices change over time, so callers can pass
 * explicit overrides (wired to the ANTHROPIC_PRICE_* env vars) to keep estimates
 * accurate without a code change. Costs are deliberately *approximate* — they
 * ignore prompt-cache and batch discounts — and are used only for soft budget
 * accounting, never for billing.
 */

/** Per-million-token prices, in USD, for one model family. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Standard API prices as of 2026-06 (USD per million tokens), keyed by the model
 * family substring found in the model id. Source: Anthropic pricing docs.
 */
const PRICE_TABLE: Array<{ match: string; price: ModelPrice }> = [
  { match: 'opus', price: { inputPerMTok: 5, outputPerMTok: 25 } },
  { match: 'sonnet', price: { inputPerMTok: 3, outputPerMTok: 15 } },
  { match: 'haiku', price: { inputPerMTok: 1, outputPerMTok: 5 } },
];

/** Used when a model id matches no known family (conservative mid-tier rate). */
const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

/** Optional explicit price overrides; a positive value wins over the table. */
export interface PriceOverride {
  inputPerMTok?: number;
  outputPerMTok?: number;
}

/**
 * Resolves the effective per-MTok price for a model: each side uses the override
 * when it is a positive number, otherwise the table entry for the model family,
 * otherwise the fallback.
 */
export function resolveModelPrice(model: string, override?: PriceOverride): ModelPrice {
  const id = model.toLowerCase();
  const fromTable = PRICE_TABLE.find((e) => id.includes(e.match))?.price ?? FALLBACK_PRICE;
  return {
    inputPerMTok:
      override?.inputPerMTok && override.inputPerMTok > 0
        ? override.inputPerMTok
        : fromTable.inputPerMTok,
    outputPerMTok:
      override?.outputPerMTok && override.outputPerMTok > 0
        ? override.outputPerMTok
        : fromTable.outputPerMTok,
  };
}

/**
 * Estimates the USD cost of a generation. Null/undefined token counts are
 * treated as 0 (e.g. when the API did not report usage), so the result is never
 * NaN. Returns a non-negative number.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  override?: PriceOverride,
): number {
  const price = resolveModelPrice(model, override);
  const inTok = Math.max(0, inputTokens ?? 0);
  const outTok = Math.max(0, outputTokens ?? 0);
  return (inTok / 1_000_000) * price.inputPerMTok + (outTok / 1_000_000) * price.outputPerMTok;
}
