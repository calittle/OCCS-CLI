import assert from 'node:assert/strict';
import test from 'node:test';
import { retryTransientRequest } from '../lib/api.js';

function serverError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

test('retries a transient 5xx request with exponential backoff', async () => {
  const delays = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  let calls = 0;

  try {
    const result = await retryTransientRequest(() => {
      calls += 1;
      if (calls < 3) throw serverError(502);
      return 'ok';
    }, { url: '/api/example', sleep: async (delay) => delays.push(delay) });

    assert.equal(result, 'ok');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
});

test('does not retry a non-transient client error', async () => {
  let calls = 0;
  await assert.rejects(
    retryTransientRequest(() => {
      calls += 1;
      throw serverError(404);
    }, { url: '/api/example', sleep: async () => assert.fail('should not sleep') }),
    /HTTP 404/
  );
  assert.equal(calls, 1);
});
