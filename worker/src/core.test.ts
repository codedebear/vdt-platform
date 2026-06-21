/**
 * Unit tests for the pure worker core. Run with: npm test (node --test via tsx).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePlaceholders,
  buildUrl,
  isHostAllowed,
  queryJsonPath,
  evaluateHttpAssertions,
  ResponseView,
} from './core';

test('resolvePlaceholders replaces known and records missing', () => {
  const { value, missing } = resolvePlaceholders(
    { headers: { Authorization: 'Bearer ${AUTH_TOKEN}' }, body: { who: '${USER}' } },
    { AUTH_TOKEN: 'abc' },
  );
  assert.equal((value as any).headers.Authorization, 'Bearer abc');
  assert.deepEqual(missing, ['USER']);
});

test('buildUrl joins base + relative path + query', () => {
  assert.equal(buildUrl('https://x.test', '/api/orders'), 'https://x.test/api/orders');
  assert.equal(
    buildUrl('https://x.test/', '/api/orders', { page: '1' }),
    'https://x.test/api/orders?page=1',
  );
});

test('isHostAllowed enforces exact host', () => {
  assert.equal(isHostAllowed('https://api.x.test/a', ['api.x.test']), true);
  assert.equal(isHostAllowed('https://evil.test/a', ['api.x.test']), false);
  assert.equal(isHostAllowed('not a url', ['api.x.test']), false);
});

test('queryJsonPath supports root, field, index, wildcard', () => {
  const doc = { count: 2, items: [{ id: 1 }, { id: 2 }] };
  assert.deepEqual(queryJsonPath(doc, '$'), [doc]);
  assert.deepEqual(queryJsonPath(doc, '$.count'), [2]);
  assert.deepEqual(queryJsonPath(doc, '$.items[0].id'), [1]);
  assert.deepEqual(queryJsonPath(doc, '$.items[*].id'), [1, 2]);
  assert.deepEqual(queryJsonPath([{ id: 9 }], '$[0].id'), [9]);
  assert.deepEqual(queryJsonPath(doc, '$.missing'), []);
});

function resp(partial: Partial<ResponseView>): ResponseView {
  return {
    status: 200,
    headers: {},
    bodyText: '',
    json: undefined,
    jsonOk: false,
    ...partial,
  };
}

test('statusCode assertion', () => {
  assert.equal(evaluateHttpAssertions([{ type: 'statusCode', equals: 200 }], resp({ status: 200 })).passed, true);
  const r = evaluateHttpAssertions([{ type: 'statusCode', equals: 200 }], resp({ status: 500 }));
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /expected status 200/);
});

test('headerContains is case-insensitive', () => {
  const res = resp({ headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.equal(
    evaluateHttpAssertions([{ type: 'headerContains', name: 'Content-Type', text: 'application/json' }], res).passed,
    true,
  );
});

test('jsonPath exists + equals', () => {
  const res = resp({ json: { count: 3, items: [{ id: 1 }] }, jsonOk: true });
  assert.equal(evaluateHttpAssertions([{ type: 'jsonPath', path: '$.count', exists: true }], res).passed, true);
  assert.equal(evaluateHttpAssertions([{ type: 'jsonPath', path: '$.count', equals: 3 }], res).passed, true);
  assert.equal(evaluateHttpAssertions([{ type: 'jsonPath', path: '$.items[*].id', exists: true }], res).passed, true);
  assert.equal(evaluateHttpAssertions([{ type: 'jsonPath', path: '$.missing', exists: true }], res).passed, false);
  assert.equal(evaluateHttpAssertions([{ type: 'jsonPath', path: '$.count', equals: 9 }], res).passed, false);
});

test('jsonPath on non-JSON body fails clearly', () => {
  const r = evaluateHttpAssertions([{ type: 'jsonPath', path: '$.x', exists: true }], resp({ jsonOk: false }));
  assert.equal(r.passed, false);
  assert.match(r.failures[0], /not JSON/);
});

test('multiple assertions all must pass', () => {
  const res = resp({ status: 200, json: { ok: true }, jsonOk: true, bodyText: '{"ok":true}' });
  const r = evaluateHttpAssertions(
    [
      { type: 'statusCode', equals: 200 },
      { type: 'jsonPath', path: '$.ok', equals: true },
      { type: 'bodyContains', text: 'ok' },
    ],
    res,
  );
  assert.equal(r.passed, true);
});
