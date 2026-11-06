import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { loadSession, updateSessionCookies } from './session.js';
import { sanitizeHttpValue, tracedHttp } from './httpTrace.js';

export const isSsoSession = session => session?.authType === 'sso';

export function authenticatedHttp(session) {
  return Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (url, ...args) => {
    const hasBody = method === 'post' || method === 'put';
    const data = hasBody ? args[0] : undefined;
    const config = { ...(hasBody ? args[1] : args[0]), method, url, ...(hasBody ? { data } : {}) };
    return sessionRequest(session, config, () => hasBody
      ? axios[method](url, data, config) : axios[method](url, config));
  }]));
}

export function ssoLoginRequired(session) {
  const selector = session?.sessionKey
    ? ` --session ${JSON.stringify(session.sessionKey)}` : '';
  return Object.assign(new Error(`SSO session expired or was rejected. Run \`occs login --sso${selector}\` and retry.`), {
    code: 'OCCS_SSO_EXPIRED', response: { status: 401, headers: {}, data: null },
  });
}

function currentCookies(session) {
  if (!session.sessionKey) return session.cookieJar;
  const current = loadSession({ sessionName: session.sessionKey });
  if (!isSsoSession(current) || current.savedAt !== session.savedAt) {
    throw new Error('Saved session changed during this command. Run the command again.');
  }
  return current.cookieJar;
}

function redactCookieValues(value, secrets) {
  if (typeof value === 'string') {
    return secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value);
  }
  if (Array.isArray(value)) return value.map(item => redactCookieValues(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCookieValues(item, secrets)]));
  }
  return value;
}

function serverErrorMessage(data) {
  const value = data?.message ?? data?.Message ?? data?.Error ?? data?.error_description;
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 800) : '';
}

// One boundary for both auth modes, including binary and multipart requests.
// Keep send injectable so callers retain their existing Axios call signatures.
export async function sessionRequest(session, config, send = () => axios(config), { trace = true } = {}) {
  if (!isSsoSession(session)) return tracedHttp(config, send, { enabled: trace });
  const base = new URL(session.baseUrl);
  const url = new URL(config.url);
  const apiPrefix = `${base.pathname.replace(/\/$/, '')}/api/`;
  const decodedPath = decodeURIComponent(url.pathname).replaceAll('\\', '/');
  if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password
    || !url.pathname.startsWith(apiPrefix) || !decodedPath.startsWith(apiPrefix)
    || decodedPath.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Refusing to send SSO credentials outside the selected Comms API.');
  }
  const serialized = currentCookies(session);
  const jar = serialized ? CookieJar.deserializeSync(serialized) : new CookieJar();
  const cookie = jar.getCookieStringSync(url.href);
  if (!cookie) throw ssoLoginRequired(session);
  config.headers = Object.fromEntries(Object.entries(config.headers || {})
    .filter(([name]) => !/^(authorization|cookie)$/i.test(name)));
  config.headers.Cookie = cookie;
  // Never forward cookies to an identity provider or another resource host.
  config.maxRedirects = 0;
  try {
    const response = await tracedHttp(config, send, { enabled: trace });
    const updates = response.headers?.['set-cookie'];
    if (updates) updateSessionCookies(session, Array.isArray(updates) ? updates : [updates], url.href);
    const type = String(response.headers?.['content-type'] || '');
    const text = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : response.data;
    const html = /text\/html/i.test(type) || (typeof text === 'string' && /^\s*<(?:!doctype\s+html|html)\b/i.test(text));
    const loginHtml = html && (config.responseType !== 'arraybuffer'
      || /(?:idcs|microsoftonline|<form[^>]+(?:login|signin)|type=["']password)/i.test(text));
    if ((response.status >= 300 && response.status < 400) || response.status === 401 || loginHtml) {
      throw ssoLoginRequired(session);
    }
    return response;
  } catch (error) {
    if (error.code === 'OCCS_SSO_EXPIRED') throw error;
    const status = error.response?.status;
    const updates = error.response?.headers?.['set-cookie'];
    if (updates) updateSessionCookies(session, Array.isArray(updates) ? updates : [updates], url.href);
    if (status === 401 || (status >= 300 && status < 400)) throw ssoLoginRequired(session);
    // Axios errors retain request headers. Do not let cookies escape through
    // callers that print errors or response bodies in verbose mode.
    const data = redactCookieValues(sanitizeHttpValue(error.response?.data), jar.getCookiesSync(url.href).map(cookie => cookie.value));
    const detail = serverErrorMessage(data);
    const summary = status === 403
      ? 'Comms denied this SSO request (403). Check your permissions and any CSRF requirements.'
      : status ? `Comms SSO request failed (${status}).` : 'Comms SSO request failed. Check connectivity and retry.';
    const safe = new Error(detail ? `${summary} ${detail}` : summary);
    safe.code = error.code;
    if (status) safe.response = { status, headers: {}, data };
    throw safe;
  }
}
