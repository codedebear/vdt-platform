/**
 * Unit tests for the pure QA step prompt builder + parser (QAX-2B-1).
 * No database or HTTP layer involved.
 */
import { buildStepPrompt } from '../src/domain/qaPrompts';
import { parseScenarioStepsDrafts, QaParseError } from '../src/domain/qaParsing';

describe('buildStepPrompt', () => {
  const base = {
    projectName: 'Acme',
    input: 'orders API spec',
    scenarios: [
      { no: 1, topic: 'Auth', testName: 'Login works', system: 'Portal' },
      { no: 2, topic: 'Orders', testName: 'List orders' },
    ],
  };

  it('lists every scenario and asks for one element per scenario', () => {
    const { system, user } = buildStepPrompt(base);
    expect(system).toMatch(/one element for EVERY scenario/i);
    expect(system).not.toMatch(/REVISING/);
    expect(user).toContain('Login works');
    expect(user).toContain('List orders');
    expect(user).toContain('Scenarios to write steps for');
    expect(user).not.toContain('Reviewer feedback');
  });

  it('switches to revision mode when feedback + current steps are present', () => {
    const { system, user } = buildStepPrompt({
      ...base,
      scenarios: [
        {
          no: 1,
          topic: 'Auth',
          testName: 'Login works',
          steps: [{ stepName: 'open login', expectedResult: 'form shown' }],
        },
      ],
      feedback: 'add a step to verify the JWT cookie',
    });
    expect(system).toMatch(/REVISING/);
    expect(user).toContain('Reviewer feedback');
    expect(user).toContain('JWT cookie');
    expect(user).toContain('full revised JSON array');
  });

  it('stays in draft mode when feedback is given but no current steps exist', () => {
    const { system } = buildStepPrompt({ ...base, feedback: 'do better' });
    expect(system).not.toMatch(/REVISING/);
  });
});

describe('parseScenarioStepsDrafts', () => {
  it('parses valid grouped steps', () => {
    const out = parseScenarioStepsDrafts(
      JSON.stringify([
        {
          no: 1,
          steps: [
            { stepName: 'open', expectedResult: 'shown' },
            { stepName: 'submit', expectedResult: 'ok' },
          ],
        },
        { no: 2, steps: [{ stepName: 'GET /orders', expectedResult: '200 + list' }] },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0].no).toBe(1);
    expect(out[0].steps).toHaveLength(2);
    expect(out[1].steps[0]).toEqual({ stepName: 'GET /orders', expectedResult: '200 + list' });
  });

  it('parses through a code fence and strips unknown keys', () => {
    const out = parseScenarioStepsDrafts(
      '```json\n[{"no":1,"steps":[{"stepName":"a","expectedResult":"b","x":1}]}]\n```',
    );
    expect(out[0].steps[0]).toEqual({ stepName: 'a', expectedResult: 'b' });
  });

  it('rejects a non-positive scenario number', () => {
    expect(() =>
      parseScenarioStepsDrafts('[{"no":0,"steps":[{"stepName":"a","expectedResult":"b"}]}]'),
    ).toThrow(/no must be a positive/);
  });

  it('rejects a scenario with no steps', () => {
    expect(() => parseScenarioStepsDrafts('[{"no":1,"steps":[]}]')).toThrow(/at least one step/);
  });

  it('rejects a step missing expectedResult', () => {
    expect(() =>
      parseScenarioStepsDrafts('[{"no":1,"steps":[{"stepName":"a"}]}]'),
    ).toThrow(/expectedResult/);
  });

  it('rejects an empty array', () => {
    expect(() => parseScenarioStepsDrafts('[]')).toThrow(QaParseError);
  });
});
