import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTypesFor } from '../lib/smoke.js';

test('smoke tests default to PDF output', () => {
  assert.deepEqual(renderTypesFor({}), ['PDF']);
});

test('a smoke test output attribute selects HTML', () => {
  assert.deepEqual(renderTypesFor({ output: 'html' }), ['HTML']);
});

test('a smoke test output attribute takes precedence over legacy render types', () => {
  assert.deepEqual(renderTypesFor({ output: 'html', renderTypes: ['PDF'] }), ['HTML']);
});
