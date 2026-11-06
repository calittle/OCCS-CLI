import fs from 'node:fs';
import { CookieJar } from 'tough-cookie';
import { saveSession, SESSION_PATH } from './session.js';
import { sessionRequest } from './sessionHttp.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

export function ssoBaseUrl({ customer, region, tenancy }) {
  const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
  if (!label.test(customer) || !label.test(region) || !label.test(tenancy)) {
    throw new Error('SSO customer, region, and tenancy must be non-empty names containing letters, numbers, or hyphens.');
  }
  return `https://${customer}.${region}.oraclecloud.com/${tenancy}`;
}

export function findSsoBrowser(explicit) {
  const candidates = [explicit, process.env.OCCS_SSO_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  if (explicit || process.env.OCCS_SSO_BROWSER) {
    if (!fs.existsSync(candidates[0])) throw new Error('The configured SSO browser executable does not exist.');
    return candidates[0];
  }
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) throw new Error('Chrome, Edge, or Chromium was not found. Set --browser-executable or OCCS_SSO_BROWSER to its executable path.');
  return executable;
}

export function cookiesFromBrowser(cookies, baseUrl) {
  const target = new URL(baseUrl);
  const jar = new CookieJar();
  for (const cookie of cookies) {
    // Only retain cookies whose actual scope includes this Comms host.
    const domain = cookie.domain.replace(/^\./, '');
    if (domain !== target.hostname && !target.hostname.endsWith(`.${domain}`)) continue;
    const attributes = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path || '/'}`];
    if (cookie.domain.startsWith('.')) attributes.push(`Domain=${domain}`);
    if (cookie.secure) attributes.push('Secure');
    if (cookie.httpOnly) attributes.push('HttpOnly');
    if (cookie.sameSite) attributes.push(`SameSite=${cookie.sameSite}`);
    if (cookie.expires > 0) attributes.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
    jar.setCookieSync(attributes.join('; '), target.origin, { ignoreError: true });
  }
  return jar.serializeSync();
}

export async function loginSso(opts, { defaults = {}, prompt, launch, request = sessionRequest, save = saveSession } = {}) {
  const timeout = Number(opts.ssoTimeout ?? 300000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('--sso-timeout must be a positive number of milliseconds.');
  let saved = {};
  if (opts.session) {
    const { loadSession } = await import('./session.js');
    try { saved = loadSession({ sessionName: opts.session }); } catch { /* A new alias is allowed. */ }
  }
  const target = {};
  for (const key of ['customer', 'region', 'tenancy']) {
    target[key] = String(opts[key] ?? (key === 'region' ? opts.environment : undefined) ?? defaults[key] ?? '').trim()
      || String(saved[key] || '');
    if (!target[key] && process.stdin.isTTY && prompt) target[key] = await prompt(`${key}: `);
    if (!target[key]) throw new Error(`SSO login requires --${key}, an environment default, or an existing --session.`);
  }
  const baseUrl = ssoBaseUrl(target);
  const executablePath = launch ? opts.browserExecutable : findSsoBrowser(opts.browserExecutable);
  if (!launch) {
    const { chromium } = await import('playwright-core');
    launch = options => chromium.launch(options);
  }
  const browser = await launch({ executablePath, headless: false });
  const session = { ...target, baseUrl, authType: 'sso', savedAt: new Date().toISOString() };
  Object.defineProperty(session, 'cookieJar', { value: undefined, writable: true, configurable: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log('Complete the SSO sign-in in the browser, including phone/passkey approval.');
    const deadline = Date.now() + timeout;
    try {
      await page.goto(`${baseUrl}/ui/Configuration/index.html`, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 30000) });
    } catch { /* Redirect chains can outlive navigation; readiness is checked below. */ }
    let ready = false;
    while (Date.now() < deadline && browser.isConnected() && !page.isClosed()) {
      const cookies = await context.cookies(baseUrl);
      if (cookies.some(cookie => cookie.name.startsWith('ORA_OCIS_CG_SESSION_'))) {
        const response = await context.request.get(`${baseUrl}/api/UIInfra/v1/UserInfo`, {
          maxRedirects: 0, timeout: Math.min(5000, Math.max(1, deadline - Date.now())),
        }).catch(() => null);
        if (response) {
          try {
            const data = response.status() === 200 ? await response.json().catch(() => null) : null;
            ready = Boolean(data?.idcs_authn_method && data?.idcs_session_id);
          } finally { await response.dispose(); }
        }
        if (ready) {
          session.cookieJar = cookiesFromBrowser(await context.cookies(baseUrl), baseUrl);
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    if (!ready) throw new Error('SSO sign-in was cancelled or timed out. Run `occs login --sso` to try again.');
  } finally {
    await browser.close();
  }
  // Prove cookies work without a running browser before persisting anything.
  const common = { timeout: resolveRequestTimeoutMs(), headers: { Accept: 'application/json' } };
  const user = await request(session, { ...common, method: 'GET', url: `${baseUrl}/api/UIInfra/v1/UserInfo` });
  if (!user.data?.idcs_session_id) throw new Error('The browser session could not be verified outside the browser.');
  const contents = await request(session, { ...common, method: 'GET',
    url: `${baseUrl}/api/CommunicationContent/v1/CommunicationContentConfigRec`, params: { limit: 1, offset: 0, summary: true } });
  if (!Array.isArray(contents.data?.Items)) throw new Error('The Comms content API did not return a valid resource list.');
  const result = save(session, { sessionName: opts.session, makeCurrent: true });
  console.log(`SSO login successful. Session: ${result.sessionKey}`);
  console.log(`Encrypted Comms session cookies saved to ${SESSION_PATH}`);
  return result;
}
