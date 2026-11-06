import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import {
  decryptStoredCredentialValue,
  encryptStoredCredentialValue,
} from './credentials.js';

const SESSION_PATH = path.join(os.homedir(), '.occs-session.json');
let storeLockHeld = false;

function normalizeSessionKeyPart(value) {
  return String(value || '').trim();
}

export function getSessionKey(session) {
  const customer = normalizeSessionKeyPart(session?.customer);
  const region = normalizeSessionKeyPart(session?.region);
  const tenancy = normalizeSessionKeyPart(session?.tenancy);
  if (!customer || !region || !tenancy) {
    return '';
  }
  return `${customer}.${region}/${tenancy}`;
}

function isSessionStore(value) {
  return value && typeof value === 'object' && value.sessions && typeof value.sessions === 'object';
}

function normalizeStore(raw) {
  if (isSessionStore(raw)) {
    return {
      currentSessionKey: raw.currentSessionKey || '',
      aliases: raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {},
      sessions: raw.sessions,
    };
  }

  const sessionKey = getSessionKey(raw);
  if (!sessionKey) {
    return {
      currentSessionKey: '',
      aliases: {},
      sessions: {},
    };
  }

  return {
    currentSessionKey: sessionKey,
    aliases: {},
    sessions: {
      [sessionKey]: {
        ...raw,
        sessionKey,
      },
    },
  };
}

function sanitizeSession(session) {
  const sanitized = {
    ...(session || {}),
  };
  delete sanitized.username;
  delete sanitized.password;
  delete sanitized.credentials;
  delete sanitized.cookieJar;
  delete sanitized.cookieJarEnc;
  return sanitized;
}

function getEncryptedCredentialsForSave(session, existingSession = {}) {
  if (session?.password) {
    return {
      username: String(session.username || existingSession.credentials?.username || '').trim(),
      passwordEnc: encryptStoredCredentialValue(session.password),
      updatedAt: new Date().toISOString(),
    };
  }

  if (session?.credentials?.passwordEnc) {
    return session.credentials;
  }

  return existingSession.credentials;
}

function migratePlaintextSessionCredentials(store) {
  let changed = false;

  for (const session of Object.values(store.sessions || {})) {
    if (!session || typeof session !== 'object') {
      continue;
    }

    if (session.password) {
      session.credentials = {
        ...(session.credentials || {}),
        username: String(session.username || session.credentials?.username || '').trim(),
        passwordEnc: encryptStoredCredentialValue(session.password),
        updatedAt: new Date().toISOString(),
      };
      delete session.password;
      delete session.username;
      changed = true;
      continue;
    }

    if (session.username && session.credentials?.passwordEnc && !session.credentials.username) {
      session.credentials.username = String(session.username).trim();
      delete session.username;
      changed = true;
    } else if (session.username && session.credentials?.username) {
      delete session.username;
      changed = true;
    }
  }

  return changed;
}

function decryptSessionCredentials(session) {
  const credentials = session?.credentials;
  if (!credentials?.passwordEnc) {
    return {};
  }

  return {
    username: String(credentials.username || '').trim(),
    password: decryptStoredCredentialValue(credentials.passwordEnc),
  };
}

function readSessionStore() {
  return withStoreLock(readSessionStoreLocked);
}

function readSessionStoreLocked() {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('Session not found. Run `occs login` first.');
  }
  const store = normalizeStore(JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')));
  if (migratePlaintextSessionCredentials(store)) {
    writeSessionStore(store);
  }
  return store;
}

function writeSessionStore(store) {
  const temporary = `${SESSION_PATH}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, SESSION_PATH);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Serialize read/modify/write across CLI processes as well as parallel requests.
function withStoreLock(action) {
  if (storeLockHeld) return action();
  const lock = `${SESSION_PATH}.lock`;
  const deadline = Date.now() + 3000;
  while (true) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Session store is busy. Retry, or remove a stale ~/.occs-session.json.lock directory after stopping other OCCS commands.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  storeLockHeld = true;
  try { return action(); } finally { storeLockHeld = false; fs.rmdirSync(lock); }
}

function attachCookies(session, stored) {
  if (stored.authType === 'sso') {
    const jar = stored.cookieJarEnc
      ? JSON.parse(decryptStoredCredentialValue(stored.cookieJarEnc))
      : stored.cookieJar;
    Object.defineProperty(session, 'cookieJar', { value: jar, writable: true, configurable: true });
  }
  return session;
}

export function updateSessionCookies(session, cookies, url) {
  const attach = value => Object.defineProperty(session, 'cookieJar', {
    value, writable: true, configurable: true, enumerable: false,
  });
  const apply = (serialized) => {
    const jar = serialized ? CookieJar.deserializeSync(serialized) : new CookieJar();
    for (const cookie of cookies) jar.setCookieSync(cookie, url, { ignoreError: true });
    return jar.serializeSync();
  };
  if (!session.sessionKey) {
    attach(apply(session.cookieJar));
    return;
  }
  withStoreLock(() => {
    const store = readSessionStore();
    const stored = store.sessions[session.sessionKey];
    if (stored?.authType !== 'sso' || stored.savedAt !== session.savedAt) {
      throw new Error('Saved session changed during this command. Run the command again.');
    }
    const next = apply(JSON.parse(decryptStoredCredentialValue(stored.cookieJarEnc)));
    stored.cookieJarEnc = encryptStoredCredentialValue(JSON.stringify(next));
    writeSessionStore(store);
    attach(next);
  });
}

function describeKnownSessions(store) {
  const keys = Object.keys(store.sessions || {});
  if (keys.length === 0) {
    return 'No saved sessions found. Run `occs login` first.';
  }
  return `Saved sessions: ${keys.join(', ')}`;
}

function resolveSessionKey(store, selector = {}) {
  const sessionName = String(selector.sessionName || '').trim();
  if (sessionName) {
    const aliasKey = store.aliases?.[sessionName];
    const key = aliasKey || sessionName;
    if (!store.sessions[key]) {
      throw new Error(`Saved session not found: ${sessionName}. ${describeKnownSessions(store)}`);
    }
    return {
      key,
      source: aliasKey ? `session alias "${sessionName}"` : `session key "${sessionName}"`,
    };
  }

  const hasTargetSelector = Boolean(selector.customer || selector.region || selector.tenancy);
  if (hasTargetSelector) {
    const current = store.sessions[store.currentSessionKey] || {};
    const target = {
      customer: selector.customer || current.customer,
      region: selector.region || current.region,
      tenancy: selector.tenancy || current.tenancy,
    };
    const key = getSessionKey(target);
    if (!key || !store.sessions[key]) {
      throw new Error(`Saved session not found for target ${key || '(incomplete target)'}. ${describeKnownSessions(store)}`);
    }
    return {
      key,
      source: 'target selector',
    };
  }

  const key = store.currentSessionKey || Object.keys(store.sessions)[0];
  if (!key || !store.sessions[key]) {
    throw new Error(describeKnownSessions(store));
  }
  return {
    key,
    source: 'current session',
  };
}

export function loadSession(selector = {}) {
  const store = readSessionStore();
  const selected = resolveSessionKey(store, selector);
  const session = store.sessions[selected.key];
  const credentials = selector.includeCredentials ? decryptSessionCredentials(session) : {};
  return attachCookies({
    ...sanitizeSession(session),
    ...credentials,
    sessionKey: selected.key,
    sessionSource: selected.source,
  }, session);
}

export function listSessions() {
  const store = readSessionStore();
  const aliasesByKey = {};
  for (const [alias, key] of Object.entries(store.aliases || {})) {
    if (!aliasesByKey[key]) {
      aliasesByKey[key] = [];
    }
    aliasesByKey[key].push(alias);
  }

  const sessions = Object.entries(store.sessions || {})
    .map(([key, session]) => ({
      ...sanitizeSession(session),
      sessionKey: key,
      aliases: aliasesByKey[key] || [],
      isCurrent: key === store.currentSessionKey,
    }))
    .sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return String(a.sessionKey).localeCompare(String(b.sessionKey));
    });

  return {
    currentSessionKey: store.currentSessionKey,
    aliases: store.aliases || {},
    sessions,
    sessionPath: SESSION_PATH,
  };
}

export function setCurrentSession(selector = {}) {
  return withStoreLock(() => setCurrentSessionLocked(selector));
}

function setCurrentSessionLocked(selector) {
  const store = readSessionStore();
  const selected = resolveSessionKey(store, selector);
  store.currentSessionKey = selected.key;
  writeSessionStore(store);

  return {
    sessionKey: selected.key,
    sessionSource: selected.source,
    session: {
      ...sanitizeSession(store.sessions[selected.key]),
      sessionKey: selected.key,
      sessionSource: selected.source,
    },
    sessionPath: SESSION_PATH,
  };
}

export function saveSession(session, options = {}) {
  return withStoreLock(() => saveSessionLocked(session, options));
}

function saveSessionLocked(session, options) {
  const key = options.sessionKey || session.sessionKey || getSessionKey(session);
  if (!key) {
    throw new Error('Cannot save session without customer, region, and tenancy.');
  }

  let store;
  try {
    store = readSessionStore();
  } catch (error) {
    if (fs.existsSync(SESSION_PATH)) throw error;
    store = {
      currentSessionKey: '',
      aliases: {},
      sessions: {},
    };
  }

  const savedSession = {
    ...(store.sessions[key] || {}),
    ...session,
    sessionKey: key,
  };
  const credentials = getEncryptedCredentialsForSave(session, store.sessions[key] || {});
  if (credentials) {
    savedSession.credentials = credentials;
  }
  delete savedSession.username;
  delete savedSession.password;
  delete savedSession.credentialSources;
  delete savedSession.credentialEnvFiles;
  delete savedSession.sessionSource;
  savedSession.authType = session.authType || 'password';
  if (savedSession.authType === 'sso') {
    if (!session.cookieJar) throw new Error('Cannot save an SSO session without cookies.');
    savedSession.cookieJarEnc = encryptStoredCredentialValue(JSON.stringify(session.cookieJar));
    delete savedSession.credentials;
    delete savedSession.token;
  } else {
    delete savedSession.cookieJarEnc;
  }
  delete savedSession.cookieJar;

  store.sessions[key] = savedSession;
  const sessionName = String(options.sessionName || '').trim();
  if (sessionName) {
    store.aliases[sessionName] = key;
    savedSession.sessionName = sessionName;
  }
  if (options.makeCurrent !== false || !store.currentSessionKey) {
    store.currentSessionKey = key;
  }

  writeSessionStore(store);
  return {
    sessionKey: key,
    sessionPath: SESSION_PATH,
  };
}

export { SESSION_PATH };
