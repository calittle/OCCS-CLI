import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { handleAxiosError } from './errorHandler.js';

const SESSION_PATH = path.join(os.homedir(), '.occs-session.json');
function extractOracleCapError(html) {
  const match = html.match(/<div id="errorMsg">\s*(.*?)\s*<\/div>/i);
  if (match && match[1]) {
    return match[1].replace(/<[^>]+>/g, '').trim();
  }
  return null;
}

async function promptValue(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await new Promise((resolve) => {
      rl.question(promptText, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

async function promptHidden(promptText) {
  if (!process.stdin.isTTY) {
    return '';
  }

  return await new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    let value = '';

    output.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    const onData = (char) => {
      if (char === '\u0003') {
        output.write('\n');
        input.setRawMode(false);
        input.pause();
        input.removeListener('data', onData);
        process.exit(1);
      }

      if (char === '\r' || char === '\n') {
        output.write('\n');
        input.setRawMode(false);
        input.pause();
        input.removeListener('data', onData);
        resolve(value.trim());
        return;
      }

      if (char === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write('\b \b');
        }
        return;
      }

      value += char;
      output.write('*');
    };

    input.on('data', onData);
  });
}

async function promptForMissingLoginData(opts) {
  const credentials = {
    username: String(opts.username ?? '').trim(),
    password: String(opts.password ?? ''),
    customer: String(opts.customer ?? '').trim(),
    region: String(opts.region ?? '').trim(),
    tenancy: String(opts.tenancy ?? '').trim(),
  };

  const requiredFields = ['username', 'password', 'customer', 'region', 'tenancy'];
  const hasMissing = requiredFields.some((field) => !credentials[field]);

  if (hasMissing && !process.stdin.isTTY) {
    throw new Error('Missing login options and interactive input is unavailable. Provide all required flags.');
  }

  if (!credentials.username) {
    credentials.username = await promptValue('Username: ');
  }
  while (!credentials.username) {
    credentials.username = await promptValue('Username (required): ');
  }

  if (!credentials.password) {
    credentials.password = await promptHidden('Password: ');
  }
  while (!credentials.password) {
    credentials.password = await promptHidden('Password (required): ');
  }

  if (!credentials.customer) {
    credentials.customer = await promptValue('Customer short name: ');
  }
  while (!credentials.customer) {
    credentials.customer = await promptValue('Customer short name (required): ');
  }

  if (!credentials.region) {
    credentials.region = await promptValue('Oracle region: ');
  }
  while (!credentials.region) {
    credentials.region = await promptValue('Oracle region (required): ');
  }

  if (!credentials.tenancy) {
    credentials.tenancy = await promptValue('Tenancy path: ');
  }
  while (!credentials.tenancy) {
    credentials.tenancy = await promptValue('Tenancy path (required): ');
  }

  return credentials;
}

export default async function loginCommand(opts) {
  let username;
  let password;
  let customer;
  let region;
  let tenancy;

  try {
    ({ username, password, customer, region, tenancy } = await promptForMissingLoginData(opts));
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }

  const baseUrl = `https://${customer}.${region}.oraclecloud.com/${tenancy}`;
  const loginUrl = `${baseUrl}/api/oauth2/v1/access`;
  console.log(`(>'-')> Logging in ${chalk.cyan(loginUrl)}...`);

  try {
    const res = await axios.post(loginUrl, {
      User: username,
      Password: password
    }, {
      headers: 
        { 
            'Accept': 'application/json', 
            'Content-Type': 'application/json' 
        }
    });

    const token = res.data.AccessToken;
    if (!token) {
      throw new Error('No token returned from Oracle.');
    }

    const session = {
      token,
      baseUrl,
      customer,
      region,
      tenancy,
      savedAt: new Date().toISOString()
    };

    fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
    console.log(`${chalk.green('✅ Login successful.')}`);
    console.log(`Session saved to ${chalk.gray(SESSION_PATH)}`);
  } catch (err) {
    handleAxiosError(err, 'Login failed');
    process.exit(1);
  }
}
