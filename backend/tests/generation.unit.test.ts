/**
 * Unit tests for the low-level generation service, using an injected fake client
 * so no real Anthropic SDK or network call is made.
 */
import {
  generateText,
  GenerationClient,
  GenerationResponse,
} from '../src/services/generation.service';
import { AppError } from '../src/middleware/errorHandler';

/** Builds a fake client whose messages.create returns the given response. */
function fakeClient(
  response: GenerationResponse,
  capture?: (args: unknown) => void,
): GenerationClient {
  return {
    messages: {
      create: async (args) => {
        capture?.(args);
        return response;
      },
    },
  };
}

describe('generateText', () => {
  it('concatenates text blocks and returns token usage', async () => {
    const client = fakeClient({
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    await expect(generateText('sys', 'user', client)).resolves.toEqual({
      text: 'Hello\nWorld',
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it('returns null token counts when usage is absent', async () => {
    const client = fakeClient({ content: [{ type: 'text', text: 'ok' }] });
    const result = await generateText('s', 'u', client);
    expect(result.text).toBe('ok');
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });

  it('ignores non-text blocks', async () => {
    const client = fakeClient({
      content: [{ type: 'tool_use' }, { type: 'text', text: 'Only this' }],
    });
    await expect((await generateText('s', 'u', client)).text).toBe('Only this');
  });

  it('passes system + user prompt through to the client', async () => {
    let seen: { system?: string; messages?: { content: string }[] } = {};
    const client = fakeClient({ content: [{ type: 'text', text: 'ok' }] }, (args) => {
      seen = args as typeof seen;
    });
    await generateText('SYSTEM-PROMPT', 'USER-PROMPT', client);
    expect(seen.system).toBe('SYSTEM-PROMPT');
    expect(seen.messages?.[0].content).toBe('USER-PROMPT');
  });

  it('throws 502 when the response has no text', async () => {
    const client = fakeClient({ content: [{ type: 'tool_use' }] });
    await expect(generateText('s', 'u', client)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('wraps client errors as a 502 AppError', async () => {
    const client: GenerationClient = {
      messages: {
        create: async () => {
          throw new Error('rate limited');
        },
      },
    };
    await expect(generateText('s', 'u', client)).rejects.toBeInstanceOf(AppError);
    await expect(generateText('s', 'u', client)).rejects.toMatchObject({ statusCode: 502 });
  });
});
