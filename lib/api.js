import axios from 'axios';
import chalk from 'chalk';
import { loadSession, saveSession } from './session.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

export const TRANSIENT_REQUEST_ATTEMPTS = 3;
export const SESSION_REFRESH_ATTEMPTS = 2;
const RETRY_DELAYS_MS = [1000, 2000];

export function isTransientServerError(error) {
  const status = error?.response?.status;
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

export function isUnauthorizedError(error) {
  const status = error?.response?.status;
  return status === 401 || status === 403;
}

function sessionCredentialSelector(session) {
  if (session?.sessionKey) return { sessionName: session.sessionKey, includeCredentials: true };
  return {
    customer: session?.customer,
    region: session?.region,
    tenancy: session?.tenancy,
    includeCredentials: true,
  };
}

export async function refreshSessionToken(session, { timeout } = {}) {
  const credentialSession = loadSession(sessionCredentialSelector(session));
  if (!credentialSession.username || !credentialSession.password) {
    throw new Error('Saved OCCS credentials are unavailable. Run `occs login` and retry.');
  }

  const response = await axios.post(
    `${String(session.baseUrl || '').replace(/\/$/, '')}/api/oauth2/v1/access`,
    { User: credentialSession.username, Password: credentialSession.password },
    {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: resolveRequestTimeoutMs(timeout),
    },
  );
  const token = response.data?.AccessToken;
  if (!token) throw new Error('No token returned while refreshing the OCCS session.');

  session.token = token;
  saveSession(session, { sessionKey: session.sessionKey, makeCurrent: false });
}

// A running export can outlive the browser-backed CCS session. Refreshing here
// keeps every request type on the same recovery path, rather than leaving each
// long-running command to rediscover an expired token independently.
export async function retryUnauthorizedRequest(session, request, {
  url,
  timeout,
  refresh = refreshSessionToken,
} = {}) {
  let lastError;
  try {
    return await request();
  } catch (error) {
    if (!isUnauthorizedError(error)) throw error;
    lastError = error;
  }

  for (let attempt = 1; attempt <= SESSION_REFRESH_ATTEMPTS; attempt += 1) {
    console.warn(chalk.yellow(
      `⚠ OCCS returned ${lastError.response?.status}; refreshing the saved session and retrying request ${attempt}/${SESSION_REFRESH_ATTEMPTS}: ${url}`,
    ));
    try {
      await refresh(session, { timeout });
    } catch (refreshError) {
      lastError = refreshError;
      if (attempt === SESSION_REFRESH_ATTEMPTS) throw refreshError;
      console.warn(chalk.yellow(`⚠ OCCS login refresh failed; retrying (${attempt}/${SESSION_REFRESH_ATTEMPTS}).`));
      continue;
    }

    try {
      return await request();
    } catch (error) {
      if (!isUnauthorizedError(error)) throw error;
      lastError = error;
      if (attempt === SESSION_REFRESH_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

// Exported independently so callers that fetch binary assets can use the same
// retry policy as JSON API calls.
export async function retryTransientRequest(request, { url, sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)) } = {}) {
  for (let attempt = 1; attempt <= TRANSIENT_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isTransientServerError(error) || attempt === TRANSIENT_REQUEST_ATTEMPTS) throw error;
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1);
      const status = error.response.status;
      console.warn(`⚠ Server error (${status}); retrying request ${attempt}/${TRANSIENT_REQUEST_ATTEMPTS - 1} in ${delay / 1000}s: ${url}`);
      await sleep(delay);
    }
  }
}

export async function get(session, url, params = {}, verbose = false, options = {}) {
  const fullUrl = `${session.baseUrl}${url}`;
  if (verbose) console.log(chalk.gray(`→ GET ${fullUrl}`));

  try {
    const res = await retryUnauthorizedRequest(session, () => retryTransientRequest(() => axios.get(fullUrl, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
      },
      params,
      timeout: resolveRequestTimeoutMs(options.timeout),
    }), { url }), { url, timeout: options.timeout });
    return res.data;
  } catch (err) {
    if (options?.throwOnError) {
      throw err;
    }

    const code = err.response?.status;
    const isTimeout = err.code === 'ECONNABORTED';

    if (code === 401 || code === 403) {
      console.error(chalk.red('❌ Unauthorized: Your token may have expired. Please run `occs login` again.'));
    } else if (code === 404) {
      console.error(chalk.red('❌ Resource not found (404). Please check your configuration or endpoint.'));
    } else if (code === 500 || code === 502) {
      console.error(chalk.red(`❌ Server error (${code}). Try again later or contact support.`));
    } else if (isTimeout) {
      console.error(chalk.red('❌ Request timed out. Check your network connection or try again.'));
    } else {
      console.error(chalk.red(`❌ Request to ${url} failed.`));
    }

    if (verbose) {
      if (err.response) {
        console.error(`Status: ${err.response.status}`);
        console.error(err.response.data);
      } else {
        console.error(err.message);
      }
    }

    process.exit(1);
  }
}

export async function paginate(session, url, params = {}, limit = 50, verbose = false, options = {}) {
  let offset = 0;
  let results = [];
  let hasMore = true;

  while (hasMore) {
    const page = await get(session, url, { ...params, offset, limit }, verbose, options);
    const items = page.Items || [];
    results.push(...items);

    if (verbose) console.log(`  ↳ got ${items.length} records (offset ${offset})`);

    hasMore = page.HasMore || items.length === limit;
    offset += limit;
  }

  return results;
}
