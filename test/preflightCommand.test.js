import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('preflight JSON uses the explicit session, reports registry objects, and fails on server errors', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-preflight-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let fail = false;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('Content-Type', 'application/json');
    if (fail) { response.statusCode = 400; response.end('{}'); return; }
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/ConfigurationId/v1/ConfigurationRec') {
      response.end(JSON.stringify({ Items: [{ ConfigurationId: '441', ConfigurationInfo: { ShortName: 'Test' } }], HasMore: false }));
    } else if (url.pathname.endsWith('/ConfigurationRec/id')) {
      assert.equal(url.searchParams.get('value'), '441');
      assert.equal(url.searchParams.get('registry'), 'true');
      response.end(JSON.stringify({ ConfigurationDomainRegistryRec: { Items: [
        { TopRecName: 'CommunicationStyleConfigRec', RecUuid: 'STYLE', Operation: 'UPDATE' },
      ] } }));
    } else {
      response.end(JSON.stringify({ CommunicationStyleConfigRec: { CommunicationStyleConfigInfo: { ShortName: 'Body' } } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const store = JSON.stringify({ currentSessionKey: 'wrong', aliases: { np: 'source' }, sessions: {
    wrong: { customer: 'test', region: 'local', tenancy: 'wrong', token: 'local', baseUrl: 'http://127.0.0.1:1' },
    source: { customer: 'test', region: 'local', tenancy: 'source', token: 'local', baseUrl: `http://127.0.0.1:${server.address().port}` },
  } });
  fs.writeFileSync(path.join(home, '.occs-session.json'), store);
  const run = extra => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/occs.js', 'preflight', '--config-id', '441', '--session', 'np',
      '--list-attached', '--deep', '--show-blockers', '--json', '--verbose', '--output', path.join(home, 'reports'), ...extra], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, HOME: home, USERPROFILE: home, OCCS_HTTP_DEBUG: '0' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  let result = await run([]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.session, { alias: 'np', sessionKey: 'source' });
  assert.equal(report.results[0].configurationId, '441');
  assert.equal(report.results[0].registryChanges[0].recUuid, 'STYLE');
  assert.equal(report.results[0].standaloneAssets[0].type, 'Style');
  assert.equal(fs.readFileSync(path.join(home, '.occs-session.json'), 'utf8'), store);
  assert.ok(requests.every(request => request.method === 'GET'));
  fail = true;
  result = await run([]);
  assert.notEqual(result.code, 0);
  assert.equal(JSON.parse(result.stdout).ok, false);
});
