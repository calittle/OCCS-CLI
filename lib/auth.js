import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { decryptPasswordValue, migratePlaintextPasswordEnvFile } from './credentials.js';
import { handleAxiosError } from './errorHandler.js';
import { SESSION_PATH, saveSession } from './session.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

function parseDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = cleaned.slice(0, eqIndex).trim();
    let value = cleaned.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function getDotEnvCandidates(opts) {
  const explicitPath = String(opts?.envFile ?? process.env.OCCS_ENV_FILE ?? '').trim();
  const homeDir = os.homedir();
  const candidates = [
    path.resolve(homeDir, '.occs.env'),
    path.resolve(homeDir, '.occs-cli', '.env'),
    path.resolve(process.cwd(), '.env'),
  ];

  if (explicitPath) {
    candidates.unshift(path.resolve(explicitPath));
  }

  return [...new Set(candidates)];
}

function loadDotEnvChain(paths) {
  const values = {};
  const sources = {};

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    const parsed = parseDotEnvFile(filePath);
    Object.assign(values, parsed);
    for (const key of Object.keys(parsed)) {
      sources[key] = `env-file:${filePath}:${key}`;
    }
  }

  return { values, sources };
}

function resolveFromEnvSources(dotEnvValues, dotEnvSources, keys) {
  for (const key of keys) {
    const processValue = process.env[key];
    if (typeof processValue === 'string' && processValue.trim()) {
      return { value: processValue.trim(), source: `process.env:${key}` };
    }
  }

  for (const key of keys) {
    const dotEnvValue = dotEnvValues[key];
    if (typeof dotEnvValue === 'string' && dotEnvValue.trim()) {
      return {
        value: dotEnvValue.trim(),
        source: dotEnvSources[key] || `env-file:${key}`,
      };
    }
  }

  return { value: '', source: 'unset' };
}

export function getConfigFromEnv(opts) {
  const { values: dotEnvValues, sources: dotEnvSources } = loadDotEnvChain(getDotEnvCandidates(opts));

  return {
    username: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_USERNAME', 'CCS_USERNAME']).value,
    password: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD', 'CCS_PASSWORD']).value,
    encryptedPassword: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD_ENC', 'CCS_PASSWORD_ENC']).value,
    passwordKey: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD_KEY', 'CCS_PASSWORD_KEY']).value,
    customer: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_CUSTOMER', 'CCS_CUSTOMER', 'CUSTOMER_SHORT_NAME', 'CUSTOMER']).value,
    region: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_ENVIRONMENT', 'CCS_ENVIRONMENT', 'OCCS_REGION', 'CCS_REGION', 'ENVIRONMENT', 'REGION']).value,
    tenancy: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_TENANCY', 'CCS_TENANCY', 'TENANCY']).value,
    emailConfigUuid: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_EMAIL_CONFIG_UUID']).value,
    emailRecipients: resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_EMAIL_RECIPIENTS']).value,
  };
}

export function resolveCredentialsFromEnv(opts = {}) {
  return resolveCredentialsWithSources(opts).credentials;
}

export function resolveCredentialsWithSources(opts = {}) {
  const dotEnvFiles = getDotEnvCandidates(opts).filter((filePath) => fs.existsSync(filePath));
  const { values: dotEnvValues, sources: dotEnvSources } = loadDotEnvChain(getDotEnvCandidates(opts));

  const envUsername = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_USERNAME', 'CCS_USERNAME']);
  const envPlainPassword = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD', 'CCS_PASSWORD']);
  const envEncryptedPassword = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD_ENC', 'CCS_PASSWORD_ENC']);
  const envPasswordKey = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_PASSWORD_KEY', 'CCS_PASSWORD_KEY']);
  const envCustomer = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_CUSTOMER', 'CCS_CUSTOMER', 'CUSTOMER_SHORT_NAME', 'CUSTOMER']);
  const envRegion = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_ENVIRONMENT', 'CCS_ENVIRONMENT', 'OCCS_REGION', 'CCS_REGION', 'ENVIRONMENT', 'REGION']);
  const envTenancy = resolveFromEnvSources(dotEnvValues, dotEnvSources, ['OCCS_TENANCY', 'CCS_TENANCY', 'TENANCY']);

  const username = String(opts.username ?? envUsername.value ?? '').trim();
  const customer = String(opts.customer ?? envCustomer.value ?? '').trim();
  const region = String(opts.region ?? opts.environment ?? envRegion.value ?? '').trim();
  const tenancy = String(opts.tenancy ?? envTenancy.value ?? '').trim();

  let password = '';
  let passwordSource = 'unset';
  if (opts.password) {
    password = String(opts.password);
    passwordSource = 'cli:password';
  } else if (envPlainPassword.value) {
    password = envPlainPassword.value;
    passwordSource = envPlainPassword.source;
  } else if (envEncryptedPassword.value) {
    password = decryptPasswordValue(envEncryptedPassword.value, envPasswordKey.value);
    passwordSource = `decrypted:${envEncryptedPassword.source}+${envPasswordKey.source}`;
  }

  return {
    credentials: {
      username,
      password,
      customer,
      region,
      tenancy,
    },
    sources: {
      username: opts.username ? 'cli:username' : envUsername.source,
      password: passwordSource,
      customer: opts.customer ? 'cli:customer' : envCustomer.source,
      region: opts.region
        ? 'cli:region'
        : (opts.environment ? 'cli:environment' : envRegion.source),
      tenancy: opts.tenancy ? 'cli:tenancy' : envTenancy.source,
    },
    dotEnvFiles,
  };
}

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
  let resolved;
  try {
    resolved = resolveCredentialsWithSources(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to decrypt OCCS_PASSWORD_ENC: ${message}`);
  }

  const credentials = resolved.credentials;
  const sources = { ...resolved.sources };
  const requiredFields = ['username', 'password', 'customer', 'region', 'tenancy'];
  const hasMissing = requiredFields.some((field) => !credentials[field]);

  if (hasMissing && !process.stdin.isTTY) {
    throw new Error('Missing login options and interactive input is unavailable. Provide all required flags.');
  }

  if (!credentials.username) {
    credentials.username = await promptValue('Username: ');
    if (credentials.username) {
      sources.username = 'prompt:username';
    }
  }
  while (!credentials.username) {
    credentials.username = await promptValue('Username (required): ');
    if (credentials.username) {
      sources.username = 'prompt:username';
    }
  }

  if (!credentials.password) {
    credentials.password = await promptHidden('Password: ');
    if (credentials.password) {
      sources.password = 'prompt:password';
    }
  }
  while (!credentials.password) {
    credentials.password = await promptHidden('Password (required): ');
    if (credentials.password) {
      sources.password = 'prompt:password';
    }
  }

  if (!credentials.customer) {
    credentials.customer = await promptValue('Customer short name: ');
    if (credentials.customer) {
      sources.customer = 'prompt:customer';
    }
  }
  while (!credentials.customer) {
    credentials.customer = await promptValue('Customer short name (required): ');
    if (credentials.customer) {
      sources.customer = 'prompt:customer';
    }
  }

  if (!credentials.region) {
    credentials.region = await promptValue('Oracle region/environment: ');
    if (credentials.region) {
      sources.region = 'prompt:region';
    }
  }
  while (!credentials.region) {
    credentials.region = await promptValue('Oracle region/environment (required): ');
    if (credentials.region) {
      sources.region = 'prompt:region';
    }
  }

  if (!credentials.tenancy) {
    credentials.tenancy = await promptValue('Tenancy path: ');
    if (credentials.tenancy) {
      sources.tenancy = 'prompt:tenancy';
    }
  }
  while (!credentials.tenancy) {
    credentials.tenancy = await promptValue('Tenancy path (required): ');
    if (credentials.tenancy) {
      sources.tenancy = 'prompt:tenancy';
    }
  }

  return {
    ...credentials,
    credentialSources: sources,
    credentialEnvFiles: resolved.dotEnvFiles,
  };
}

export default async function loginCommand(opts) {
  let username;
  let password;
  let customer;
  let region;
  let tenancy;
  let credentialSources;

  try {
    ({
      username,
      password,
      customer,
      region,
      tenancy,
      credentialSources,
    } = await promptForMissingLoginData(opts));
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
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: resolveRequestTimeoutMs(),
    });

    const token = res.data.AccessToken;
    if (!token) {
      throw new Error('No token returned from Oracle.');
    }

    const session = {
      token,
      baseUrl,
      username,
      password,
      customer,
      region,
      tenancy,
      savedAt: new Date().toISOString()
    };

    const saved = saveSession(session, {
      sessionName: opts.session,
      makeCurrent: true,
    });
    console.log(`${chalk.green('✅ Login successful.')}`);
    console.log(`Session saved to ${chalk.gray(SESSION_PATH)}`);
    console.log(`Session key: ${chalk.cyan(saved.sessionKey)}`);
    console.log(chalk.gray('Encrypted credentials saved for token refresh.'));
    if (opts.session) {
      console.log(`Session alias: ${chalk.cyan(opts.session)}`);
    }

    try {
      const migration = migratePlaintextPasswordEnvFile({
        password,
        source: credentialSources?.password,
      });
      if (migration.migrated) {
        console.log(chalk.gray(`Encrypted plaintext ${migration.removedKey} in ${migration.filePath}.`));
      }
    } catch (migrationErr) {
      const message = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
      console.warn(chalk.yellow(`⚠ Login succeeded, but plaintext env password could not be encrypted: ${message}`));
    }
  } catch (err) {
    handleAxiosError(err, 'Login failed');
    process.exit(1);
  }
}
