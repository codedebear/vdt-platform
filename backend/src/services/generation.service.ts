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

/** The slice of the Anthropic message response this service reads. */
export interface GenerationResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** A plain text content block. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * A document content block — how a PDF is handed to Claude so it reads the file
 * (text and scanned pages via vision) directly, without our own extraction.
 */
export interface DocumentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ContentBlock = TextBlock | DocumentBlock;

/** The slice of the Anthropic client this service depends on. The user message
 * content may be a plain string (no attachments) or an array of content blocks
 * (a text block plus one document block per attached PDF). */
export interface GenerationClient {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string | ContentBlock[] }[];
    }): Promise<GenerationResponse>;
  };
}

/** Result of a generation: the text plus token accounting. */
export interface GenerationResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

let cachedClient: GenerationClient | null = null;

/**
 * Lazily constructs (and caches) the real Anthropic client, configured with a
 * request timeout and retry budget from env.
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
    default: new (opts: {
      apiKey: string;
      timeout?: number;
      maxRetries?: number;
    }) => GenerationClient;
  };
  cachedClient = new Anthropic({
    apiKey: env.anthropicApiKey,
    timeout: env.anthropicTimeoutMs,
    maxRetries: env.anthropicMaxRetries,
  });
  return cachedClient;
}

/**
 * Sends a system + user prompt to Claude and returns the text plus token usage.
 * @param system - The system prompt fixing the agent role.
 * @param user - The user prompt carrying project context.
 * @param client - Optional injected client (used by tests); falls back to the
 *   real Anthropic client built from env.
 * @param documents - Optional PDF document blocks to attach to the user message.
 *   When present, the user content is sent as `[text, ...documents]`; otherwise
 *   it remains a plain string (unchanged behaviour).
 * @throws {AppError} 503 if unconfigured, 502 if the API returns no text or errors.
 */
export async function generateText(
  system: string,
  user: string,
  client?: GenerationClient,
  documents?: DocumentBlock[],
): Promise<GenerationResult> {
  const c = client ?? (await getDefaultClient());

  const content: string | ContentBlock[] =
    documents && documents.length > 0
      ? [{ type: 'text', text: user }, ...documents]
      : user;

  let response: GenerationResponse;
  try {
    response = await c.messages.create({
      model: env.anthropicModel,
      max_tokens: env.anthropicMaxTokens,
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    // Log the raw upstream error server-side; return a generic message so
    // internal details are not leaked to the client.
    // eslint-disable-next-line no-console
    console.error('Anthropic generation error:', err);
    throw new AppError('AI generation request failed upstream', 502);
  }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();

  if (!text) {
    throw new AppError('AI generation returned an empty response', 502);
  }

  return {
    text,
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
  };
}
