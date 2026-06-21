/**
 * Unit tests for the QA compile contract, prompt builder and parser (QAX-2B-2).
 * No database or HTTP layer involved.
 */
import {
  artifactSpecSchema,
  selectorSchema,
  httpArtifactSchema,
} from '../src/domain/qaArtifact';
import { buildCompilePrompt } from '../src/domain/qaPrompts';
import { parseCompiledArtifacts, QaParseError } from '../src/domain/qaParsing';

describe('selectorSchema', () => {
  it('accepts a single locator field', () => {
    expect(selectorSchema.safeParse({ role: 'button', name: 'Save' }).success).toBe(true);
    expect(selectorSchema.safeParse({ label: 'Email' }).success).toBe(true);
    expect(selectorSchema.safeParse({ testId: 'submit' }).success).toBe(true);
  });

  it('rejects an empty selector', () => {
    expect(selectorSchema.safeParse({}).success).toBe(false);
  });
});

describe('artifactSpecSchema', () => {
  it('validates an HTTP artifact', () => {
    const ok = artifactSpecSchema.safeParse({
      kind: 'HTTP',
      request: { method: 'GET', path: '/api/orders' },
      assertions: [{ type: 'statusCode', equals: 200 }],
    });
    expect(ok.success).toBe(true);
  });

  it('validates a BROWSER artifact with resilient selectors', () => {
    const ok = artifactSpecSchema.safeParse({
      kind: 'BROWSER',
      actions: [
        { type: 'goto', path: '/login' },
        { type: 'fill', selector: { label: 'Email' }, value: '${TEST_USER}' },
        { type: 'click', selector: { role: 'button', name: 'Sign in' } },
      ],
      assertions: [{ type: 'urlContains', text: '/dashboard' }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(artifactSpecSchema.safeParse({ kind: 'SHELL', cmd: 'rm' }).success).toBe(false);
  });

  it('rejects an HTTP artifact with no assertions', () => {
    const bad = httpArtifactSchema.safeParse({
      kind: 'HTTP',
      request: { method: 'GET', path: '/x' },
      assertions: [],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a bad HTTP method', () => {
    const bad = artifactSpecSchema.safeParse({
      kind: 'HTTP',
      request: { method: 'FETCH', path: '/x' },
      assertions: [{ type: 'statusCode', equals: 200 }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('buildCompilePrompt', () => {
  const base = {
    projectName: 'Acme',
    input: 'orders API',
    scenarios: [
      {
        no: 1,
        testName: 'List orders',
        steps: [{ no: 1, order: 1, stepName: 'GET orders', expectedResult: '200 + list' }],
      },
    ],
  };

  it('describes the contract and asks for one artifact per step', () => {
    const { system, user } = buildCompilePrompt(base);
    expect(system).toContain('"kind": "HTTP"');
    expect(system).toContain('"kind": "BROWSER"');
    expect(system).toContain('RELATIVE');
    expect(system).toContain('${VAR}');
    expect(system).not.toMatch(/REVISING/);
    expect(user).toContain('Steps to compile');
    expect(user).toContain('GET orders');
  });

  it('switches to revision mode when feedback + current artifacts present', () => {
    const { system } = buildCompilePrompt({
      ...base,
      scenarios: [
        {
          no: 1,
          testName: 'List orders',
          steps: [
            {
              no: 1,
              order: 1,
              stepName: 'GET orders',
              expectedResult: '200',
              artifact: { kind: 'HTTP' },
            },
          ],
        },
      ],
      feedback: 'assert the response is a JSON array',
    });
    expect(system).toMatch(/REVISING/);
  });
});

describe('parseCompiledArtifacts', () => {
  it('parses and validates compiled artifacts keyed by (no, order)', () => {
    const out = parseCompiledArtifacts(
      JSON.stringify([
        {
          no: 1,
          order: 1,
          artifact: {
            kind: 'HTTP',
            request: { method: 'GET', path: '/api/orders' },
            assertions: [{ type: 'statusCode', equals: 200 }],
          },
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].no).toBe(1);
    expect(out[0].order).toBe(1);
    expect(out[0].artifact.kind).toBe('HTTP');
  });

  it('parses through a code fence', () => {
    const out = parseCompiledArtifacts(
      '```json\n[{"no":1,"order":1,"artifact":{"kind":"BROWSER","actions":[{"type":"goto","path":"/"}],"assertions":[{"type":"urlContains","text":"/"}]}}]\n```',
    );
    expect(out[0].artifact.kind).toBe('BROWSER');
  });

  it('rejects an entry whose artifact violates the contract', () => {
    expect(() =>
      parseCompiledArtifacts(
        '[{"no":1,"order":1,"artifact":{"kind":"HTTP","request":{"method":"GET","path":"/x"},"assertions":[]}}]',
      ),
    ).toThrow(QaParseError);
  });

  it('rejects a missing order', () => {
    expect(() =>
      parseCompiledArtifacts(
        '[{"no":1,"artifact":{"kind":"HTTP","request":{"method":"GET","path":"/x"},"assertions":[{"type":"statusCode","equals":200}]}}]',
      ),
    ).toThrow(/order/);
  });

  it('rejects an empty array', () => {
    expect(() => parseCompiledArtifacts('[]')).toThrow(QaParseError);
  });
});
