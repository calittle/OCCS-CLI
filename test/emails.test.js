import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { EMAIL_LIST_ENDPOINT, emailSummary, fetchEmails, writeEmailCache } from '../lib/emails.js';

const record = (uuid = 'EMAIL-PARENT') => ({
  CommunicationEmailConfigRec: {
    CommunicationEmailConfigUuid: uuid,
    CommunicationEmailConfigInfo: { ShortName: 'Test_Email', Name: 'Test Email', ConfigId: '185' },
    Status: { Items: [{ StatusCode: 'Active', EffDtTm: '2026-03-19T00:00:00.000000Z' }] },
  },
  ConfigurationRec: { ConfigurationUuid: 'AUTHORING-CONFIG' },
});

test('maps the parent Communication Email UUID rather than authoring or version identifiers', () => {
  assert.deepEqual(emailSummary(record()), {
    uuid: 'EMAIL-PARENT', shortName: 'Test_Email', name: 'Test Email', configId: '185',
    statuses: [{ status: 'Active', effectiveAt: '2026-03-19T00:00:00.000000Z' }],
  });
  assert.throws(() => emailSummary({ ConfigurationUuid: 'AUTHORING-CONFIG' }), /without CommunicationEmailConfigUuid/);
});

test('paginates with HAR parameters, timeout, and no verbose stdout in JSON mode', async () => {
  const calls = [];
  const session = { token: 'secret-not-for-cache', baseUrl: 'https://example.invalid/non-prod', sessionKey: 'customer.region/non-prod' };
  const payload = await fetchEmails(session, { session: 'np', json: true, verbose: true, timeout: '1234' },
    async (...args) => {
      calls.push(args);
      return calls.length === 1 ? { Items: [record()], HasMore: true } : { Items: [record('SECOND')], HasMore: false };
    });
  assert.equal(payload.count, 2);
  assert.equal(calls[1][2].offset, 49);
  assert.equal(calls[0][1], EMAIL_LIST_ENDPOINT);
  assert.deepEqual(calls[0][2], { offset: 0, limit: 49, depth: true, summary: true, totalResults: true });
  assert.equal(calls[0][3], false);
  assert.deepEqual(calls[0][4], { timeout: '1234', throwOnError: true });
  assert.equal(JSON.stringify(payload).includes(session.token), false);
});

test('rejects malformed and incomplete responses instead of caching empty success', async () => {
  await assert.rejects(fetchEmails({}, {}, async () => ({})), /missing Items/);
  await assert.rejects(fetchEmails({}, {}, async () => ({ Items: [], HasMore: true })), /empty page/);
});

function runCli(args, home, debug = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/occs.js', ...args], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, USERPROFILE: home, OCCS_HTTP_DEBUG: debug ? '1' : '0' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI JSON, cache preservation on failure, and get-everything export/resume', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-emails-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let fail = false, emailRequests = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith(EMAIL_LIST_ENDPOINT)) {
      emailRequests += 1;
      if (fail) { response.statusCode = 400; response.end(JSON.stringify({ error: 'bad request' })); return; }
      response.end(JSON.stringify({ Items: [record()], HasMore: false }));
    } else response.end(JSON.stringify({ Items: [], HasMore: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const key = 'test.local/non-prod';
  fs.writeFileSync(path.join(home, '.occs-session.json'), JSON.stringify({
    currentSessionKey: key, aliases: { np: key },
    sessions: { [key]: { customer: 'test', region: 'local', tenancy: 'non-prod', token: 'local-only', baseUrl: `http://127.0.0.1:${server.address().port}` } },
  }));
  const output = path.join(home, 'cache', 'emails');
  let result = await runCli(['list-emails', '--session', 'np', '--json', '--verbose', '--output', output], home, true);
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(result.stderr, /@OCCS_HTTP@/);
  assert.equal(result.stderr.includes('local-only'), false);
  assert.equal(payload.emails[0].uuid, 'EMAIL-PARENT');
  assert.equal(payload.session.alias, 'np');
  assert.equal(payload.session.sessionKey, key);
  const previous = fs.readFileSync(path.join(output, 'index.json'), 'utf8');
  assert.deepEqual(JSON.parse(previous), payload);
  fail = true;
  result = await runCli(['list-emails', '--json', '--output', output], home);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(fs.readFileSync(path.join(output, 'index.json'), 'utf8'), previous);
  fail = false;
  for (const mode of ['--fresh', '--resume']) {
    const before = emailRequests;
    result = await runCli(['get-everything', '--output', path.join(home, 'all'), mode], home);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    const cached = JSON.parse(fs.readFileSync(path.join(home, 'all', 'emails', 'index.json'), 'utf8'));
    assert.equal(cached.emails[0].uuid, 'EMAIL-PARENT');
    assert.equal(emailRequests, before + 1);
  }
  const before = emailRequests;
  result = await runCli(['list-emails', '--json'], home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(emailRequests, before + 1);
  assert.equal(fs.existsSync(path.join(home, 'output')), false);
});
