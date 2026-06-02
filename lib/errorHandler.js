import chalk from 'chalk';
import os from 'os';
import fs from 'fs';
import path from 'path';

export function handleAxiosError(err, context = 'Request failed') {
  const res = err.response;

  if (res) {
    if (res.status === 401) {
      console.error(chalk.red(`❌ ${context}: Unauthorized (401). Your session may have expired. Please log in again.`));
      return;
    }

    const contentType = res.headers['content-type'] || '';
    const responseText = Buffer.isBuffer(res.data) ? res.data.toString('utf8') : res.data;

    if (contentType.includes('application/json')) {
      try {
        const parsed = typeof responseText === 'string' ? JSON.parse(responseText) : responseText;
        console.error(chalk.red(`❌ ${context}:`), parsed);
      } catch {
        console.error(chalk.red(`❌ ${context}:`), responseText);
      }

    } else if (contentType.includes('text/html')) {
      const message = extractOracleCapError(responseText);
      if (message) {
        console.error(chalk.red(`❌ ${context}: ${message}`));

        if (/Common Access Point/i.test(message)) {
          console.error(chalk.yellow('👉 Check that your customer, region, and tenancy are correct.')); 
          console.error(chalk.yellow('Valid tenancy values: prod, non-prod, pre-prod (lowercase)'));
        }
      } else {
        console.error(chalk.red(`❌ ${context}: Oracle returned an HTML error page.`));
      }
      writeHtmlErrorDump(responseText);

    } else {
      console.error(chalk.red(`❌ ${context}: Unexpected content type:`), contentType);
      console.error(responseText);
    }

  } else {
    console.error(chalk.red(`❌ ${context}: Network or internal error:`), err.message);
  }
}

function extractOracleCapError(html) {
  const match = html.match(/<div id="errorMsg">\s*(.*?)\s*<\/div>/i);
  return match?.[1]?.replace(/<[^>]+>/g, '').trim() || null;
}

function writeHtmlErrorDump(html) {
  const file = path.join(os.tmpdir(), 'occs-error.html');
  fs.writeFileSync(file, html, 'utf-8');
  console.log(chalk.gray(`🔍 Raw error HTML saved to: ${file}`));
}
