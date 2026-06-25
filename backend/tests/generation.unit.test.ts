/**
 * Unit tests for the low-level generation service, using an injected fake client
 * so no real Anthropic SDK or network call is made.
 */
import {
  generateText,
  submitBatch,
  collectBatchResults,
  BatchGenerationClient,
  BatchHandle,
  BatchIndividualResponse,
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

  describe('529 retry', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('retries on 529 and succeeds on the third attempt', async () => {
      let calls = 0;
      const client: GenerationClient = {
        messages: {
          create: async () => {
            calls++;
            if (calls < 3) throw Object.assign(new Error('overloaded'), { status: 529 });
            return { content: [{ type: 'text', text: 'ok' }] };
          },
        },
      };
      const promise = generateText('s', 'u', client);
      await jest.runAllTimersAsync();
      await expect(promise).resolves.toMatchObject({ text: 'ok' });
      expect(calls).toBe(3);
    });

    it('throws 503 after exhausting 529 retries', async () => {
      const client: GenerationClient = {
        messages: {
          create: async () => {
            throw Object.assign(new Error('overloaded'), { status: 529 });
          },
        },
      };
      const promise = generateText('s', 'u', client);
      // Attach the rejection handler BEFORE advancing timers so Node doesn't
      // emit an unhandled-rejection warning during the retry sleeps.
      const assertion = expect(promise).rejects.toMatchObject({ statusCode: 503 });
      await jest.runAllTimersAsync();
      await assertion;
    });

    it('does not retry on non-529 errors', async () => {
      let calls = 0;
      const client: GenerationClient = {
        messages: {
          create: async () => {
            calls++;
            throw Object.assign(new Error('server error'), { status: 500 });
          },
        },
      };
      await expect(generateText('s', 'u', client)).rejects.toMatchObject({ statusCode: 502 });
      expect(calls).toBe(1);
    });
  });
});

/** Builds a fake batch client capturing the create args and returning a handle. */
function fakeBatchClient(
  handle: BatchHandle,
  capture?: (args: unknown) => void,
): BatchGenerationClient {
  return {
    beta: {
      messages: {
        batches: {
          create: async (args) => {
            capture?.(args);
            return handle;
          },
          retrieve: async () => handle,
          results: async () => [] as BatchIndividualResponse[],
        },
      },
    },
  };
}

describe('submitBatch', () => {
  it('returns the batch id and sends the run id as custom_id', async () => {
    let seen: { requests?: Array<{ custom_id: string; params: { system: string } }> } = {};
    const client = fakeBatchClient(
      { id: 'msgbatch_123', processing_status: 'in_progress' },
      (args) => {
        seen = args as typeof seen;
      },
    );
    const id = await submitBatch('SYS', 'USER', 'exec-42', client);
    expect(id).toBe('msgbatch_123');
    expect(seen.requests?.[0].custom_id).toBe('exec-42');
    expect(seen.requests?.[0].params.system).toBe('SYS');
  });

  it('wraps a create failure as a 502 AppError', async () => {
    const client: BatchGenerationClient = {
      beta: {
        messages: {
          batches: {
            create: async () => {
              throw new Error('upstream down');
            },
            retrieve: async () => ({ id: 'x', processing_status: 'ended' }),
            results: async () => [],
          },
        },
      },
    };
    await expect(submitBatch('s', 'u', 'c', client)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('collectBatchResults', () => {
  it('drains the async results stream into an array', async () => {
    const items: BatchIndividualResponse[] = [
      {
        custom_id: 'exec-42',
        result: {
          type: 'succeeded',
          message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1 } },
        },
      },
    ];
    const client: BatchGenerationClient = {
      beta: {
        messages: {
          batches: {
            create: async () => ({ id: 'x', processing_status: 'ended' }),
            retrieve: async () => ({ id: 'x', processing_status: 'ended' }),
            results: async () => items,
          },
        },
      },
    };
    await expect(collectBatchResults('x', client)).resolves.toEqual(items);
  });
});
