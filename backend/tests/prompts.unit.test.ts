/**
 * Unit tests for the pure prompt builder. No API or database involved.
 */
import { buildPrompt, PromptContext } from '../src/domain/prompts';

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    projectName: 'Acme Portal',
    track: 'FULL_SDLC',
    phaseType: 'PLANNER',
    priorOutputs: [],
    ...overrides,
  };
}

describe('buildPrompt', () => {
  it('puts the phase role in the system prompt', () => {
    expect(buildPrompt(ctx({ phaseType: 'PLANNER' })).system).toMatch(/Planner agent/);
    expect(buildPrompt(ctx({ phaseType: 'DEV' })).system).toMatch(/Developer agent/);
    expect(buildPrompt(ctx({ phaseType: 'QA' })).system).toMatch(/QA Engineer agent/);
    expect(buildPrompt(ctx({ phaseType: 'CODE_REVIEW' })).system).toMatch(/Code Reviewer agent/);
    expect(buildPrompt(ctx({ phaseType: 'DOCS' })).system).toMatch(/Technical Writer agent/);
  });

  it('includes project name and description in the user prompt', () => {
    const { user } = buildPrompt(ctx({ description: 'A customer portal' }));
    expect(user).toMatch(/Acme Portal/);
    expect(user).toMatch(/A customer portal/);
  });

  it('describes the track', () => {
    expect(buildPrompt(ctx({ track: 'QA_ONLY' })).user).toMatch(/QA_ONLY track/);
    expect(buildPrompt(ctx({ track: 'FULL_SDLC' })).user).toMatch(/FULL_SDLC track/);
  });

  it('embeds the run input when present', () => {
    const { user } = buildPrompt(ctx({ input: 'GET /users returns a list' }));
    expect(user).toMatch(/GET \/users returns a list/);
  });

  it('omits the input section when input is empty/whitespace', () => {
    const { user } = buildPrompt(ctx({ input: '   ' }));
    expect(user).not.toMatch(/Input for this/);
  });

  it('includes prior approved outputs labelled by phase', () => {
    const { user } = buildPrompt(
      ctx({
        phaseType: 'DEV',
        priorOutputs: [{ phaseType: 'PLANNER', output: 'The approved plan body' }],
      }),
    );
    expect(user).toMatch(/Approved outputs from earlier phases/);
    expect(user).toMatch(/Planner output/);
    expect(user).toMatch(/The approved plan body/);
  });

  it('omits the prior-outputs section when there are none', () => {
    const { user } = buildPrompt(ctx({ priorOutputs: [] }));
    expect(user).not.toMatch(/Approved outputs from earlier phases/);
  });

  it('always ends with an explicit task instruction', () => {
    expect(buildPrompt(ctx({ phaseType: 'DOCS' })).user).toMatch(
      /Produce the Technical Writer deliverable/,
    );
  });
});
