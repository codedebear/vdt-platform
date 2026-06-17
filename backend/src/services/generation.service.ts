/**
 * Low-level Claude API access for phase generation.
 *
 * The Anthropic SDK is loaded lazily (dynamic import) and behind a minimal
 * interface so that:
 *  - the app boots even when ANTHROPIC_API_KEY is unset (a generate call then
 *    fails with a clear 503), and
 *  - unit tests can inject a fake client without the SDK being installed.
 */
import { env } from '../config/env';
import { AppError } from '../middleware/errorHandler';

/** The slice of the Anthropic client this service depends on. */
export interface GenerationClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

let cachedClient: GenerationClient | null = null;

/**
 * Lazily constructs (and caches) the real Anthropic client.
 * @throws {AppError} 503 if ANTHROPIC_API_KEY is not configured.
 */
async function getDefaultClient(): Promise<GenerationClient> {
  if (cachedClient) {
    return cachedClient;
  }
  if (!env.anthropicApiKey) {
    throw new AppError('AI generation is not configured (ANTHROPIC_API_KEY is missing)', 503);
  }
  // Loaded via a non-literal specifier so the SDK is a runtime-only dependency:
  // the app (and its unit tests, which inject a fake client) compile and boot
  // without it installed; it is resolved here only when a real generate runs.
  const sdkModule = '@anthropic-ai/sdk';
  const { default: Anthropic } = (await import(sdkModule)) as {
    default: new (opts: { apiKey: string }) => GenerationClient;
  };
  cachedClient = new Anthropic({ apiKey: env.anthropicApiKey });
  return cachedClient;
}

/**
 * Sends a system + user prompt to Claude and returns the concatenated text.
 * @param system - The system prompt fixing the agent role.
 * @param user - The user prompt carrying project context.
 * @param client - Optional injected client (used by tests); falls back to the
 *   real Anthropic client built from env.
 * @returns The generated Markdown text.
 * @throws {AppError} 503 if unconfigured, 502 if the API returns no text or errors.
 */
export async function generateText(
  system: string,
  user: string,
  client?: GenerationClient,
): Promise<string> {
  const c = client ?? (await getDefaultClient());

  let response: { content: Array<{ type: string; text?: string }> };
  try {
    response = await c.messages.create({
      model: env.anthropicModel,
      max_tokens: env.anthropicMaxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    throw new AppError(`AI generation failed: ${(err as Error).message}`, 502);
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();

  if (!text) {
    throw new AppError('AI generation returned an empty response', 502);
  }
  return text;
}
