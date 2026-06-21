/**
 * Unit tests for the pure QA scenario prompt builder + parser (QAX-2A).
 * No database or HTTP layer involved.
 */
import { buildScenarioPrompt } from '../src/domain/qaPrompts';
import {
  parseScenarioDrafts,
  extractJsonArray,
  QaParseError,
} from '../src/domain/qaParsing';

describe('buildScenarioPrompt', () => {
  it('puts the project name, description and input into the user message', () => {
    const { system, user } = buildScenarioPrompt({
      projectName: 'Acme Portal',
      description: 'Trade-in web app',
      input: 'GET /api/orders returns the order list',
    });
    expect(system).toMatch(/QA test designer/i);
    expect(system).toMatch(/ONLY a JSON array/i);
    expect(user).toContain('Acme Portal');
    expect(user).toContain('Trade-in web app');
    expect(user).toContain('GET /api/orders');
  });

  it('omits optional sections cleanly when absent', () => {
    const { user } = buildScenarioPrompt({ projectName: 'Bare' });
    expect(user).toContain('Bare');
    expect(user).not.toContain('Description:');
    expect(user).not.toContain('Specification / context');
  });
});

describe('extractJsonArray', () => {
  it('returns a bare array unchanged', () => {
    expect(extractJsonArray('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it('strips a ```json code fence', () => {
    expect(extractJsonArray('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
  });

  it('strips a plain ``` fence', () => {
    expect(extractJsonArray('```\n[1,2]\n```')).toBe('[1,2]');
  });

  it('slices an array out of surrounding prose', () => {
    expect(extractJsonArray('Here you go: [1, 2] hope that helps')).toBe('[1, 2]');
  });

  it('throws when there is no array', () => {
    expect(() => extractJsonArray('no json here')).toThrow(QaParseError);
  });
});

describe('parseScenarioDrafts', () => {
  it('parses a valid scenario array', () => {
    const out = parseScenarioDrafts(
      JSON.stringify([
        { topic: 'Auth', testName: 'Login works', system: 'Portal', remark: 'happy path' },
        { topic: 'Auth', testName: 'Bad password rejected' },
      ]),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      topic: 'Auth',
      testName: 'Login works',
      system: 'Portal',
      remark: 'happy path',
    });
    // Optional fields omitted (not set to undefined) when absent.
    expect(out[1]).toEqual({ topic: 'Auth', testName: 'Bad password rejected' });
  });

  it('parses through a code fence', () => {
    const out = parseScenarioDrafts('```json\n[{"topic":"T","testName":"N"}]\n```');
    expect(out[0]).toEqual({ topic: 'T', testName: 'N' });
  });

  it('drops unknown keys (strip) but keeps required ones', () => {
    const out = parseScenarioDrafts('[{"topic":"T","testName":"N","bogus":123}]');
    expect(out[0]).toEqual({ topic: 'T', testName: 'N' });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseScenarioDrafts('[{topic:')).toThrow(QaParseError);
  });

  it('rejects an empty array', () => {
    expect(() => parseScenarioDrafts('[]')).toThrow(/empty scenario list/);
  });

  it('rejects an element missing a required field', () => {
    expect(() => parseScenarioDrafts('[{"topic":"T"}]')).toThrow(/testName/);
  });

  it('rejects a blank required field', () => {
    expect(() => parseScenarioDrafts('[{"topic":"  ","testName":"N"}]')).toThrow(QaParseError);
  });
});
