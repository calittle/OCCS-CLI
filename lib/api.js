import axios from 'axios';
import chalk from 'chalk';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

export const TRANSIENT_REQUEST_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];

export function isTransientServerError(error) {
  const status = error?.response?.status;
  return Number.isInteger(status) && status >= 500 && status <= 599;
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
    const res = await retryTransientRequest(() => axios.get(fullUrl, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
      },
      params,
      timeout: resolveRequestTimeoutMs(options.timeout),
    }), { url });
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
