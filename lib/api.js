import axios from 'axios';
import chalk from 'chalk';

export async function get(session, url, params = {}, verbose = false, options = {}) {
  const fullUrl = `${session.baseUrl}${url}`;
  if (verbose) console.log(chalk.gray(`→ GET ${fullUrl}`));

  try {
    const res = await axios.get(fullUrl, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: 'application/json',
      },
      params,
      timeout: 10000,
    });
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

export async function paginate(session, url, params = {}, limit = 50, verbose = false) {
  let offset = 0;
  let results = [];
  let hasMore = true;

  while (hasMore) {
    const page = await get(session, url, { ...params, offset, limit }, verbose);
    const items = page.Items || [];
    results.push(...items);

    if (verbose) console.log(`  ↳ got ${items.length} records (offset ${offset})`);

    hasMore = page.HasMore || items.length === limit;
    offset += limit;
  }

  return results;
}
