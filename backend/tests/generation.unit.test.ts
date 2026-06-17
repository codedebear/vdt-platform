/**
 * Unit tests for the low-level generation service, using an injected fake client
 * so no real Anthropic SDK or network call is made.
 */
import { generateText, GenerationClient } from '../src/services/generation.service';
import { AppError } from '../src/middleware/errorHandler';

/** Builds a fake client whose messages.create returns the given content blocks. */
function fakeClient(
  content: Array<{ type: string; text?: string }>,
  capture?: (args: unknown) => void,
): GenerationClient {
  return {
    messages: {
      create: async (args) => {
        capture?.(args);
        return { content };
      },
    },
  };
}

describe('generateText', () => {
  it('concatenates text blocks from the response', async () => {
    const client = fakeClient([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ]);
    await expect(generateText('sys', 'user', client)).resolves.toBe('Hello\nWorld');
  });

  it('ignores non-text blocks', async () => {
    const client = fakeClient([
      { type: 'tool_use' },
      { type: 'text', text: 'Only this' },
    ]);
    await expect(generateText('sys', 'user', client)).resolves.toBe('Only this');
  });

  it('passes system + user prompt through to the client', async () => {
    let seen: { system?: string; messages?: { content: string }[] } = {};
    const client = fakeClient([{ type: 'text', text: 'ok' }], (args) => {
      seen = args as typeof seen;
    });
    await generateText('SYSTEM-PROMPT', 'USER-PROMPT', client);
    expect(seen.system).toBe('SYSTEM-PROMPT');
    expect(seen.messages?.[0].content).toBe('USER-PROMPT');
  });

  it('throws 502 when the response has no text', async () => {
    const client = fakeClient([{ type: 'tool_use' }]);
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
