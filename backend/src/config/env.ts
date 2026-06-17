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
};
