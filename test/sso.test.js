import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { CookieJar } from 'tough-cookie';

// All storage tests use a disposable home; never read the developer's sessions.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-sso-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { loadSession, saveSession, listSessions, updateSessionCookies, SESSION_PATH } = await import('../lib/session.js');
const { sessionRequest } = await import('../lib/sessionHttp.js');
const { retryUnauthorizedRequest, get, mutateJson, postMultipart } = await import('../lib/api.js');
const { cookiesFromBrowser, loginSso, ssoBaseUrl } = await import('../lib/sso.js');
const axios = (await import('axios')).default;
after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

function session(tenancy = 'non-prod') {
  const baseUrl = `https://example.region.oraclecloud.com/${tenancy}`;
  const jar = new CookieJar();
  jar.setCookieSync('ORA_OCIS_CG_SESSION_test_1=synthetic-cookie-one; Secure; HttpOnly; Path=/', baseUrl);
  jar.setCookieSync('ORA_OCIS_CG_SESSION_test_2=synthetic-cookie-two; Secure; HttpOnly; Path=/', baseUrl);
  return { authType: 'sso', customer: 'example', region: 'region', tenancy, baseUrl,
    savedAt: new Date().toISOString(), cookieJar: jar.serializeSync() };
}
const response = (data = { Items: [] }, headers = {}) => ({ status: 200, headers, data });
const config = s => ({ method: 'GET', url: `${s.baseUrl}/api/example`, headers: { Authorization: 'Bearer stale' } });

test('encrypts SSO cookies, hides them from enumeration, and switches auth methods cleanly', () => {
  const s = session();
  const key = saveSession({ ...s, username: 'unused', password: 'unused-password', token: 'unused-token' }, { sessionName: 'sso' }).sessionKey;
  const disk = fs.readFileSync(SESSION_PATH, 'utf8');
  for (const secret of ['synthetic-cookie-one', 'synthetic-cookie-two', 'unused-password', 'unused-token']) assert.equal(disk.includes(secret), false);
  assert.equal(fs.statSync(SESSION_PATH).mode & 0o777, 0o600);
  const loaded = loadSession({ sessionName: 'sso', includeCredentials: true });
  assert.equal(loaded.authType, 'sso');
  assert.equal(loaded.password, undefined);
  assert.equal(CookieJar.deserializeSync(loaded.cookieJar).getCookiesSync(s.baseUrl).length, 2);
  assert.equal(JSON.stringify(loaded).includes('synthetic'), false);
  assert.equal(JSON.stringify(listSessions()).includes('cookieJar'), false);
  saveSession({ ...s, authType: 'password', username: 'user', password: 'password', token: 'token' });
  const stored = JSON.parse(fs.readFileSync(SESSION_PATH)).sessions[key];
  assert.equal(stored.cookieJarEnc, undefined);
  assert.ok(stored.credentials.passwordEnc);
  saveSession(s);
  assert.equal(JSON.parse(fs.readFileSync(SESSION_PATH)).sessions[key].credentials, undefined);
});

test('uses both cookie fragments, strips bearer auth, and refuses host and tenancy escapes', async () => {
  const s = session();
  const c = config(s);
  await sessionRequest(s, c, async () => {
    assert.match(c.headers.Cookie, /synthetic-cookie-one/);
    assert.match(c.headers.Cookie, /synthetic-cookie-two/);
    assert.equal(c.headers.Authorization, undefined);
    assert.equal(c.maxRedirects, 0);
    return response();
  });
  for (const url of ['https://other.invalid/non-prod/api/example', s.baseUrl.replace('non-prod', 'prod') + '/api/example', s.baseUrl + '/api/../ui/login', s.baseUrl.replace('https:', 'http:') + '/api/example']) {
    await assert.rejects(sessionRequest(s, { ...config(s), url }, () => assert.fail('must not send')), /outside/);
  }
  const expired = session(); expired.cookieJar = new CookieJar().serializeSync();
  await assert.rejects(sessionRequest(expired, config(expired), () => assert.fail('must not send')), /occs login --sso/);
});

test('persists cookie rotation and deletion, and reloads newer cookies across session objects', async () => {
  saveSession(session());
  const first = loadSession({ sessionName: 'sso' });
  const second = loadSession({ sessionName: 'sso' });
  await Promise.all([
    sessionRequest(first, config(first), async () => response({}, { 'set-cookie': ['A=one; Secure; Path=/'] })),
    sessionRequest(second, config(second), async () => response({}, { 'set-cookie': ['B=two; Secure; Path=/'] })),
  ]);
  updateSessionCookies(first, ['A=; Max-Age=0; Path=/'], first.baseUrl);
  const c = config(second);
  await sessionRequest(second, c, async () => {
    assert.match(c.headers.Cookie, /B=two/);
    assert.doesNotMatch(c.headers.Cookie, /A=one/);
    return response();
  });
  saveSession({ ...session(), savedAt: 'replacement-login' });
  await assert.rejects(sessionRequest(first, config(first), () => assert.fail('must not send')), /changed/);
});

test('parallel CLI processes merge cookie changes without losing other sessions', async () => {
  saveSession(session());
  saveSession(session('prod'));
  const jobs = ['first', 'second', 'third'].map(name => new Promise((resolve, reject) => {
    const script = `import {loadSession,updateSessionCookies} from './lib/session.js';
      const s=loadSession({sessionName:'sso'});
      updateSessionCookies(s,['${name}=synthetic; Secure; Path=/'],s.baseUrl);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url), env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(jobs);
  const s = loadSession({ sessionName: 'sso' });
  const cookies = CookieJar.deserializeSync(s.cookieJar).getCookieStringSync(s.baseUrl);
  for (const name of ['first', 'second', 'third']) assert.match(cookies, new RegExp(`${name}=synthetic`));
  const prod = loadSession({ customer: 'example', region: 'region', tenancy: 'prod' });
  assert.doesNotMatch(CookieJar.deserializeSync(prod.cookieJar).getCookieStringSync(prod.baseUrl), /first=synthetic/);
});

test('detects redirects and HTML sign-in, preserves 403, and never retries SSO authentication', async () => {
  const s = session();
  for (const result of [
    { status: 302, headers: { location: 'https://identity.invalid/?token=secret' }, data: '' },
    response('<html>Sign in</html>', { 'content-type': 'text/html' }),
  ]) {
    await assert.rejects(sessionRequest(s, config(s), async () => result), error => error.code === 'OCCS_SSO_EXPIRED' && !JSON.stringify(error).includes('secret'));
  }
  let calls = 0;
  await assert.rejects(retryUnauthorizedRequest(s, async () => {
    calls++;
    return sessionRequest(s, config(s), async () => {
      throw Object.assign(new Error('request details with cookie'), { config: { headers: { Cookie: 'synthetic-cookie-one' } },
        response: { status: 403, data: { Cookie: 'synthetic-cookie-one' } } });
    });
  }, { refresh: () => assert.fail('must not refresh') }), error => {
    assert.equal(error.response.status, 403);
    assert.equal(error.config, undefined);
    assert.equal(JSON.stringify(error).includes('synthetic-cookie-one'), false);
    return true;
  });
  assert.equal(calls, 1);
  // An authored HTML blob remains a legitimate download.
  await sessionRequest(s, { ...config(s), responseType: 'arraybuffer' }, async () => response(Buffer.from('<html>content</html>'), { 'content-type': 'text/html' }));
});

test('shows the server validation reason for an empty ConfigId while stripping request credentials', async () => {
  const s = session();
  const reason = 'There is no domain associated, so cannot close the configuration';
  await assert.rejects(sessionRequest(s, config(s), async () => {
    throw Object.assign(new Error('unsafe Axios details'), {
      config: { headers: { Cookie: 'synthetic-cookie-one' } },
      response: { status: 400, data: {
        message: reason,
        messageCode: 'ConfigurationId_E-CID_1044',
        Cookie: 'synthetic-cookie-one',
        echoedValue: 'synthetic-cookie-two',
      } },
    });
  }), error => {
    assert.match(error.message, /There is no domain associated/);
    assert.equal(error.response.data.message, reason);
    assert.equal(error.response.data.messageCode, 'ConfigurationId_E-CID_1044');
    assert.equal(error.config, undefined);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-cookie/);
    return true;
  });
});

test('shared JSON and multipart paths use cookies and redact them from debug output', async () => {
  const s = session();
  const oldAdapter = axios.defaults.adapter;
  const oldDebug = process.env.OCCS_HTTP_DEBUG;
  const write = process.stderr.write;
  let output = '', calls = 0;
  process.env.OCCS_HTTP_DEBUG = '1';
  process.stderr.write = value => { output += value; return true; };
  axios.defaults.adapter = async c => {
    calls++;
    assert.match(c.headers.Cookie, /synthetic-cookie-one/);
    assert.equal(c.headers.Authorization, undefined);
    return { ...response({ Items: [], idcs_session_id: 'private-session-id' }, { 'set-cookie': ['A=renewed-secret; Secure; Path=/'] }), config: c };
  };
  try {
    await get(s, '/api/example');
    await mutateJson(s, 'post', '/api/example', { value: 1 });
    await postMultipart(s, '/api/example', Buffer.from('upload'));
  } finally {
    axios.defaults.adapter = oldAdapter;
    process.stderr.write = write;
    if (oldDebug === undefined) delete process.env.OCCS_HTTP_DEBUG; else process.env.OCCS_HTTP_DEBUG = oldDebug;
  }
  assert.equal(calls, 3);
  assert.equal(output.includes('synthetic-cookie-one'), false);
  assert.equal(output.includes('renewed-secret'), false);
  assert.equal(output.includes('private-session-id'), false);
  assert.match(output, /redacted/);
});

test('binary download and comparison paths use cookie authentication', async () => {
  const { downloadBlob, downloadFont } = await import('../lib/download.js');
  const { ResourceReader } = await import('../lib/resourceCompareSources.js');
  const s = session();
  const oldAdapter = axios.defaults.adapter;
  let calls = 0;
  axios.defaults.adapter = async c => {
    calls++;
    assert.match(c.headers.Cookie, /synthetic-cookie-two/);
    assert.equal(c.headers.Authorization, undefined);
    return { ...response(Buffer.from('binary')), config: c };
  };
  try {
    assert.equal(await downloadBlob(s, 'blob', path.join(home, 'blob')), true);
    assert.equal(await downloadFont(s, 'font', path.join(home, 'font')), true);
    const reader = new ResourceReader('content', 'test', { session: s });
    assert.equal((await reader.binary('blob')).toString(), 'binary');
  } finally { axios.defaults.adapter = oldAdapter; }
  assert.equal(calls, 3);
});

test('browser cookie export retains scope and excludes Microsoft cookies', () => {
  const jar = CookieJar.deserializeSync(cookiesFromBrowser([
    { name: 'COMMS', value: 'cookie', domain: 'example.region.oraclecloud.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: -1 },
    { name: 'MICROSOFT', value: 'private', domain: '.microsoftonline.com', path: '/', expires: -1 },
  ], session().baseUrl));
  const cookies = jar.getCookiesSync(session().baseUrl);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].hostOnly, true);
  assert.equal(jar.getCookieStringSync('https://other.oraclecloud.com/'), '');
  assert.throws(() => ssoBaseUrl({ customer: '../evil', region: 'region', tenancy: 'non-prod' }), /names/);
});

test('login closes browser before validating external API access and saves only after both reads succeed', async () => {
  const calls = [];
  const browser = {
    isConnected: () => true, close: async () => calls.push('close'),
    newContext: async () => ({
      newPage: async () => ({ goto: async () => {}, isClosed: () => false }),
      cookies: async () => [{ name: 'ORA_OCIS_CG_SESSION_test_1', value: 'synthetic', domain: 'example.region.oraclecloud.com', path: '/', secure: true, expires: -1 }],
      request: { get: async () => ({ status: () => 200, json: async () => ({ idcs_authn_method: 'oauth', idcs_session_id: 'session' }), dispose: async () => {} }) },
    }),
  };
  const opts = { sso: true, customer: 'example', region: 'region', tenancy: 'non-prod' };
  const deps = { launch: async () => browser,
    request: async (s, config) => sessionRequest(s, config, async () => {
      assert.ok(calls.includes('close'));
      calls.push('request');
      return response(config.url.endsWith('UserInfo') ? { idcs_session_id: 'session' } : { Items: [] },
        { 'set-cookie': ['renewed=synthetic; Secure; Path=/'] });
    }),
    save: s => { calls.push('save'); assert.ok(s.cookieJar); return { sessionKey: 'test' }; },
  };
  await loginSso(opts, deps);
  assert.deepEqual(calls, ['close', 'request', 'request', 'save']);
  calls.length = 0;
  await assert.rejects(loginSso(opts, { ...deps, request: async () => { throw new Error('external API failed'); } }), /external API failed/);
  assert.deepEqual(calls, ['close']);
});

test('closing the login window cleans up without saving or sending standalone API requests', async () => {
  let closed = false;
  await assert.rejects(loginSso({ customer: 'example', region: 'region', tenancy: 'non-prod' }, {
    launch: async () => ({
      isConnected: () => true,
      close: async () => { closed = true; },
      newContext: async () => ({ newPage: async () => ({ goto: async () => {}, isClosed: () => true }) }),
    }),
    request: () => assert.fail('must not request'),
    save: () => assert.fail('must not save'),
  }), /cancelled or timed out/);
  assert.equal(closed, true);
});

test('CLI SSO bypasses invalid encrypted password defaults and validates input before browser launch', () => {
  const run = spawnSync(process.execPath, ['bin/occs.js', 'login', '--sso', '--sso-timeout', 'invalid'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OCCS_PASSWORD_ENC: 'invalid', OCCS_PASSWORD_KEY: 'invalid' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /sso-timeout/);
  assert.doesNotMatch(run.stderr, /decrypt/);
});

test('package reads, ConfigId writes, JSON preview and local-XSD preview use SSO without passwords', () => {
  saveSession(session());
  const input = path.join(home, 'input.json');
  const xml = path.join(home, 'input.xml');
  const xsd = path.join(home, 'input.xsd');
  fs.writeFileSync(input, '{"billPrint":{}}');
  fs.writeFileSync(xml, '<root><value>example</value></root>');
  fs.writeFileSync(xsd, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="root"><xs:complexType><xs:sequence><xs:element name="value" type="xs:string"/></xs:sequence></xs:complexType></xs:element></xs:schema>');
  const script = `
    import assert from 'node:assert/strict';
    import axios from 'axios';
    import {packageListCommand} from './lib/packageMaintenance.js';
    import {createConfigCommand} from './lib/migration.js';
    import {previewCommand} from './lib/preview.js';
    let calls=0;
    axios.defaults.adapter=async c=>{
      calls++;
      assert.match(c.headers.Cookie,/synthetic-cookie-one/);
      assert.equal(c.headers.Authorization,undefined);
      assert.ok(!c.url.includes('/oauth2/'));
      const preview=c.url.includes('/CommunicationAssembly/');
      return {status:200,headers:{'content-type':preview?'application/pdf':'application/json'},
        data:preview?Buffer.from('%PDF-1.4 synthetic preview'): {Items:[],HasMore:false,ConfigurationId:'1',ConfigurationInfo:{ShortName:'test'}},config:c};
    };
    await packageListCommand('',{session:'sso',json:true});
    await createConfigCommand('test',{session:'sso',json:true});
    await previewCommand({session:'sso',input:${JSON.stringify(input)},package:'test',renderType:['PDF'],output:${JSON.stringify(path.join(home, 'preview.pdf'))}});
    await previewCommand({session:'sso',input:${JSON.stringify(xml)},xsd:${JSON.stringify(xsd)},package:'test',renderType:['PDF'],output:${JSON.stringify(path.join(home, 'xml-preview.pdf'))}});
    assert.equal(calls,4);
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, OCCS_PASSWORD_ENC: 'invalid', OCCS_PASSWORD_KEY: 'invalid' },
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(fs.readFileSync(path.join(home, 'preview.pdf'), 'utf8'), /^%PDF/);
  assert.match(fs.readFileSync(path.join(home, 'xml-preview.pdf'), 'utf8'), /^%PDF/);
});

test('migration rejects an SSO source before sending requests without an explicit bearer token', () => {
  saveSession(session('prod'));
  const script = `
    import axios from 'axios';
    import {migrateCommand} from './lib/migration.js';
    axios.defaults.adapter=()=>{throw new Error('must not send a request');};
    await migrateCommand(undefined,{sourceSession:'sso',targetSession:'example.region/prod',dryRun:true,json:true});
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { ...process.env },
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /explicit --source-token/);
  assert.doesNotMatch(run.stdout + run.stderr, /must not send/);
});
