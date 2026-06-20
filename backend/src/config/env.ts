/**
 * Centralized, validated access to environment variables.
 * Fails fast on startup if a required variable is missing or malformed.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  PORT: z.string().default('4000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // AI generation (Anthropic). Optional so the app still boots without it; the
  // generation service returns a clear 503 if a generate call is attempted while
  // the key is unset.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MAX_TOKENS: z.coerce.number().int().positive().default(8000),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  ANTHROPIC_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  // Cost/abuse guards for the paid /generate endpoint.
  GENERATE_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
  GENERATE_MAX_PER_RUN: z.coerce.number().int().positive().default(5),
  // Per-project AI cost budget (approximate USD). Default applied to new
  // projects; 0 means unlimited (stored as null on the project). Enforced as a
  // hard block on /generate once a project's accumulated spend reaches it.
  PROJECT_BUDGET_USD_DEFAULT: z.coerce.number().min(0).default(0),
  // Optional per-million-token price overrides for the active model. When unset
  // (0), the built-in pricing table (domain/pricing.ts) is used. Set these if
  // Anthropic's prices change so cost estimates stay accurate without a redeploy.
  ANTHROPIC_PRICE_INPUT_PER_MTOK: z.coerce.number().min(0).default(0),
  ANTHROPIC_PRICE_OUTPUT_PER_MTOK: z.coerce.number().min(0).default(0),
  // Prompt cost guards: cap the stored run input and each prior-phase output
  // folded into a generation prompt, to bound token cost (cost-DoS protection).
  INPUT_MAX_CHARS: z.coerce.number().int().positive().default(100000),
  PRIOR_OUTPUT_MAX_CHARS: z.coerce.number().int().positive().default(20000),
  // Attachment limits. Kept tight because files are stored inline in Postgres
  // (Neon free tier is 0.5GB) and large docs inflate generation token cost.
  ATTACHMENT_MAX_FILE_MB: z.coerce.number().positive().default(10),
  ATTACHMENT_MAX_PER_RUN: z.coerce.number().int().positive().default(5),
  ATTACHMENT_MAX_TOTAL_MB: z.coerce.number().positive().default(25),
  // Per-user rate limit for the upload endpoint (writes to Postgres + buffers in
  // memory), to protect the shared storage/memory budget from abuse.
  ATTACHMENT_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  // Max characters of extracted text included per non-PDF attachment when
  // generating, to cap token cost. Extracted text beyond this is truncated.
  ATTACHMENT_TEXT_CHAR_CAP: z.coerce.number().int().positive().default(100000),
  // Anthropic Message Batches API (BE-BATCH-1): async generation at ~50% cost.
  // BATCH_ENABLED gates both the batch-submit path and the background poller.
  BATCH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // How often (ms) the in-process poller scans QUEUED runs for finished batches.
  BATCH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  // Fraction of the standard token price charged for batch runs (Anthropic bills
  // batches at 50%). Used for the budget reservation + settle on batch runs.
  ANTHROPIC_BATCH_PRICE_FACTOR: z.coerce.number().positive().max(1).default(0.5),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables');
}

/** Strongly-typed, validated environment configuration used throughout the backend. */
export const env = {
  databaseUrl: parsed.data.DATABASE_URL,
  jwtSecret: parsed.data.JWT_SECRET,
  jwtExpiresIn: parsed.data.JWT_EXPIRES_IN,
  port: Number(parsed.data.PORT),
  nodeEnv: parsed.data.NODE_ENV,
  anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
  anthropicModel: parsed.data.ANTHROPIC_MODEL,
  anthropicMaxTokens: parsed.data.ANTHROPIC_MAX_TOKENS,
  anthropicTimeoutMs: parsed.data.ANTHROPIC_TIMEOUT_MS,
  anthropicMaxRetries: parsed.data.ANTHROPIC_MAX_RETRIES,
  generateRateLimitPerMin: parsed.data.GENERATE_RATE_LIMIT_PER_MIN,
  generateMaxPerRun: parsed.data.GENERATE_MAX_PER_RUN,
  projectBudgetUsdDefault: parsed.data.PROJECT_BUDGET_USD_DEFAULT,
  anthropicPriceInputPerMTok: parsed.data.ANTHROPIC_PRICE_INPUT_PER_MTOK,
  anthropicPriceOutputPerMTok: parsed.data.ANTHROPIC_PRICE_OUTPUT_PER_MTOK,
  inputMaxChars: parsed.data.INPUT_MAX_CHARS,
  priorOutputMaxChars: parsed.data.PRIOR_OUTPUT_MAX_CHARS,
  attachmentMaxFileMb: parsed.data.ATTACHMENT_MAX_FILE_MB,
  attachmentMaxPerRun: parsed.data.ATTACHMENT_MAX_PER_RUN,
  attachmentMaxTotalMb: parsed.data.ATTACHMENT_MAX_TOTAL_MB,
  attachmentRateLimitPerMin: parsed.data.ATTACHMENT_RATE_LIMIT_PER_MIN,
  attachmentTextCharCap: parsed.data.ATTACHMENT_TEXT_CHAR_CAP,
  batchEnabled: parsed.data.BATCH_ENABLED,
  batchPollIntervalMs: parsed.data.BATCH_POLL_INTERVAL_MS,
  anthropicBatchPriceFactor: parsed.data.ANTHROPIC_BATCH_PRICE_FACTOR,
};
