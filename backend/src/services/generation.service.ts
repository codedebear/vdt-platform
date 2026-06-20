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

/** Messages API creation parameters for one request (shared by the sync and
 * batch paths). The user content may be a plain string (no attachments) or an
 * array of content blocks (a text block plus one document block per PDF). */
export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string | ContentBlock[] }[];
}

/** The slice of the Anthropic client this service depends on for sync calls. */
export interface GenerationClient {
  messages: {
    create(args: MessageCreateParams): Promise<GenerationResponse>;
  };
}

/** A handle to a submitted Message Batch (subset of BetaMessageBatch). */
export interface BatchHandle {
  id: string;
  processing_status: 'in_progress' | 'canceling' | 'ended';
  results_url?: string | null;
}

/** One per-request entry in a finished batch's results (subset of
 * BetaMessageBatchIndividualResponse). `message` carries the Messages-API
 * response shape this service already understands. */
export interface BatchIndividualResponse {
  custom_id: string;
  result: {
    type: 'succeeded' | 'errored' | 'canceled' | 'expired';
    message?: GenerationResponse;
  };
}

/** The slice of the Anthropic client this service depends on for batch calls.
 * Mirrors `client.beta.messages.batches.*` in @anthropic-ai/sdk 0.30.x. */
export interface BatchGenerationClient {
  beta: {
    messages: {
      batches: {
        create(args: {
          requests: Array<{ custom_id: string; params: MessageCreateParams }>;
        }): Promise<BatchHandle>;
        retrieve(messageBatchId: string): Promise<BatchHandle>;
        // The SDK returns an async (JSONL) stream; a sync iterable is also
        // accepted so tests can return a plain array. `for await` handles both.
        results(
          messageBatchId: string,
        ): Promise<AsyncIterable<BatchIndividualResponse> | Iterable<BatchIndividualResponse>>;
      };
    };
  };
}

/** Result of a generation: the text plus token accounting. */
export interface GenerationResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The real Anthropic client exposes both the sync and batch surfaces. */
type AnthropicClient = GenerationClient & BatchGenerationClient;

let cachedClient: AnthropicClient | null = null;

/**
 * Lazily constructs (and caches) the real Anthropic client, configured with a
 * request timeout and retry budget from env.
 * @throws {AppError} 503 if ANTHROPIC_API_KEY is not configured.
 */
async function getDefaultClient(): Promise<AnthropicClient> {
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
    }) => AnthropicClient;
  };
  cachedClient = new Anthropic({
    apiKey: env.anthropicApiKey,
    timeout: env.anthropicTimeoutMs,
    maxRetries: env.anthropicMaxRetries,
  });
  return cachedClient;
}

/** Builds the user-message content: a plain string when there are no document
 * attachments, otherwise a text block followed by one document block per PDF. */
function buildUserContent(user: string, documents?: DocumentBlock[]): string | ContentBlock[] {
  return documents && documents.length > 0
    ? [{ type: 'text', text: user }, ...documents]
    : user;
}

/**
 * Parses a Messages-API response into our {@link GenerationResult}: joins the
 * text blocks and reads token usage. Shared by the synchronous path and the
 * batch poller (which receives the same response shape per batch result).
 * @throws {AppError} 502 if the response contains no text.
 */
export function parseGenerationResponse(response: GenerationResponse): GenerationResult {
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

  let response: GenerationResponse;
  try {
    response = await c.messages.create({
      model: env.anthropicModel,
      max_tokens: env.anthropicMaxTokens,
      system,
      messages: [{ role: 'user', content: buildUserContent(user, documents) }],
    });
  } catch (err) {
    // Log only the error message server-side (not the raw error object, which
    // can carry request/prompt content); return a generic message to the client.
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Anthropic generation error:', message);
    throw new AppError('AI generation request failed upstream', 502);
  }

  return parseGenerationResponse(response);
}

/**
 * Submits a single generation request to the Anthropic Message Batches API
 * (async, ~50% cheaper) and returns the batch id to persist on the run. The
 * `customId` (the PhaseExecution id) lets the poller match the result back to
 * the run. Content is built identically to {@link generateText}.
 * @param client - Optional injected batch client (used by tests).
 * @throws {AppError} 503 if unconfigured, 502 if the batch could not be created.
 */
export async function submitBatch(
  system: string,
  user: string,
  customId: string,
  client?: BatchGenerationClient,
  documents?: DocumentBlock[],
): Promise<string> {
  const c = client ?? (await getDefaultClient());
  try {
    const batch = await c.beta.messages.batches.create({
      requests: [
        {
          custom_id: customId,
          params: {
            model: env.anthropicModel,
            max_tokens: env.anthropicMaxTokens,
            system,
            messages: [{ role: 'user', content: buildUserContent(user, documents) }],
          },
        },
      ],
    });
    return batch.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Anthropic batch submit error:', message);
    throw new AppError('AI batch submission failed upstream', 502);
  }
}

/**
 * Retrieves the current state of a submitted batch. Wraps upstream errors so a
 * transient failure surfaces as a 502 and the poller leaves the run QUEUED.
 * @param client - Optional injected batch client (used by tests).
 */
export async function retrieveBatch(
  batchId: string,
  client?: BatchGenerationClient,
): Promise<BatchHandle> {
  const c = client ?? (await getDefaultClient());
  try {
    return await c.beta.messages.batches.retrieve(batchId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Anthropic batch retrieve error:', message);
    // A 404 is terminal (the batch no longer exists upstream); surface it as 404
    // so the poller can fail the run instead of polling it forever. Everything
    // else is treated as transient (502) and the run is left QUEUED for a retry.
    const status = (err as { status?: number })?.status;
    throw new AppError(
      status === 404 ? 'AI batch not found upstream' : 'AI batch status check failed upstream',
      status === 404 ? 404 : 502,
    );
  }
}

/**
 * Fetches and collects all per-request results of an ended batch into an array
 * (batches here hold a single request, so this is tiny). The SDK returns a
 * streaming JSONL decoder; we drain it.
 * @param client - Optional injected batch client (used by tests).
 */
export async function collectBatchResults(
  batchId: string,
  client?: BatchGenerationClient,
): Promise<BatchIndividualResponse[]> {
  const c = client ?? (await getDefaultClient());
  let stream: AsyncIterable<BatchIndividualResponse> | Iterable<BatchIndividualResponse>;
  try {
    stream = await c.beta.messages.batches.results(batchId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('Anthropic batch results error:', message);
    throw new AppError('AI batch results fetch failed upstream', 502);
  }
  const out: BatchIndividualResponse[] = [];
  for await (const item of stream) {
    out.push(item);
  }
  return out;
}
