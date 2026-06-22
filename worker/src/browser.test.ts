/**
 * Pure unit tests for browser.ts (QAX-4). Cover the deterministic helpers —
 * selector strategy precedence, descriptions, and ${VAR} resolution of a
 * browser artifact. The page-driving parts (runBrowserStep against Chromium)
 * are verified by a real browser run on the worker host.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSelector, selectorDescription } from './browser';
import { resolvePlaceholders } from './core';

test('planSelector precedence: testId beats everything', () => {
  const plan = planSelector({ testId: 'submit', role: 'button', name: 'Save', label: 'x', text: 'y', css: '.z' });
  assert.deepEqual(plan, { strategy: 'testId', value: 'submit' });
});

test('planSelector: role+name when no testId', () => {
  const plan = planSelector({ role: 'button', name: 'Save', label: 'x', text: 'y', css: '.z' });
  assert.deepEqual(plan, { strategy: 'role', role: 'button', name: 'Save' });
});

test('planSelector: role without name keeps name undefined', () => {
  const plan = planSelector({ role: 'heading' });
  assert.deepEqual(plan, { strategy: 'role', role: 'heading', name: undefined });
});

test('planSelector: label > text > css', () => {
  assert.equal(planSelector({ label: 'Email', text: 't', css: '.c' }).strategy, 'label');
  assert.equal(planSelector({ text: 'Welcome', css: '.c' }).strategy, 'text');
  assert.deepEqual(planSelector({ css: '#root .btn' }), { strategy: 'css', value: '#root .btn' });
});

test('planSelector: empty selector throws', () => {
  assert.throws(() => planSelector({}), /none of testId/);
});

test('selectorDescription is readable for each kind', () => {
  assert.equal(selectorDescription({ testId: 'submit' }), 'testId=submit');
  assert.equal(selectorDescription({ role: 'button', name: 'Save' }), 'role=button[name="Save"]');
  assert.equal(selectorDescription({ role: 'button' }), 'role=button');
  assert.equal(selectorDescription({ label: 'Email' }), 'label="Email"');
  assert.equal(selectorDescription({ text: 'Hi' }), 'text="Hi"');
  assert.equal(selectorDescription({ css: '.btn' }), 'css=.btn');
  assert.equal(selectorDescription({}), '(empty selector)');
});

test('browser artifact: ${VAR} resolves in fill values and goto path', () => {
  const artifact = {
    kind: 'BROWSER' as const,
    actions: [
      { type: 'goto' as const, path: '/login?u=${USERNAME}' },
      { type: 'fill' as const, selector: { label: 'Password' }, value: '${PASSWORD}' },
    ],
    assertions: [{ type: 'urlContains' as const, text: '/home' }],
  };
  const { value, missing } = resolvePlaceholders(artifact, { USERNAME: 'alice', PASSWORD: 's3cret' });
  assert.equal(missing.length, 0);
  assert.equal(value.actions[0].type === 'goto' && value.actions[0].path, '/login?u=alice');
  assert.equal(value.actions[1].type === 'fill' && value.actions[1].value, 's3cret');
});

test('browser artifact: missing secret is reported', () => {
  const artifact = {
    kind: 'BROWSER' as const,
    actions: [{ type: 'fill' as const, selector: { label: 'Password' }, value: '${PASSWORD}' }],
    assertions: [{ type: 'textVisible' as const, text: 'ok' }],
  };
  const { missing } = resolvePlaceholders(artifact, {});
  assert.deepEqual(missing, ['PASSWORD']);
});
