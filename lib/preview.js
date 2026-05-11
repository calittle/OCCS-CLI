import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSession, saveSession } from './session.js';
import { handleAxiosError } from './errorHandler.js';
import { resolveCredentialsWithSources } from './auth.js';

const RENDER_EXTENSIONS = {
  PDF: '.pdf',
  HTML: '.html',
  CSV: '.csv',
  JSON: '.json',
  METADATA: '.json',
};
const XML_TO_JSON_BATCH_CONFIG_UUID = '21AF6D09E0E1488DB35A292CF8DC9D00';

function normalizeRenderType(value) {
  return String(value ?? 'PDF').trim().toUpperCase();
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getEffectiveDate(input) {
  if (!input) {
    return formatLocalDate(new Date());
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }

  const parsed = new Date(String(input));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid effective date. Use ISO format like YYYY-MM-DD.');
  }

  return formatLocalDate(parsed);
}

function resolveOutputPath(inputPath, outputPath, renderType) {
  const extension = RENDER_EXTENSIONS[renderType] || '.bin';
  const parsedInput = path.parse(inputPath);

  if (!outputPath) {
    return path.join(parsedInput.dir, `${parsedInput.name}${extension}`);
  }

  const resolvedOutput = path.resolve(outputPath);

  if (fs.existsSync(resolvedOutput) && fs.statSync(resolvedOutput).isDirectory()) {
    return path.join(resolvedOutput, `${parsedInput.name}${extension}`);
  }

  if (!path.extname(resolvedOutput)) {
    return `${resolvedOutput}${extension}`;
  }

  return resolvedOutput;
}

function isLikelyBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function decodeMaybeBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!isLikelyBase64(normalized)) {
    return null;
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (!decoded.length) {
    return null;
  }

  return decoded;
}

function getNestedValue(source, pathKeys) {
  return pathKeys.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), source);
}

function extractStringPayload(payload) {
  if (typeof payload === 'string') {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidates = [
    ['AssemblyData'],
    ['Data'],
    ['Result'],
    ['result'],
    ['CommunicationAssemblyInfo', 'AssemblyData'],
    ['CommunicationAssemblyInfo', 'Data'],
  ];

  for (const keyPath of candidates) {
    const value = getNestedValue(payload, keyPath);
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function decodeResponseBody(rawData, contentType) {
  const bodyBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData || '');

  if (contentType.includes('application/json') || contentType.includes('text/')) {
    const bodyText = bodyBuffer.toString('utf8').trim();

    if (!bodyText) {
      return bodyBuffer;
    }

    try {
      const parsed = JSON.parse(bodyText);
      const payloadString = extractStringPayload(parsed);
      if (!payloadString) {
        return bodyBuffer;
      }

      return decodeMaybeBase64(payloadString) || Buffer.from(payloadString, 'utf8');
    } catch {
      return decodeMaybeBase64(bodyText) || Buffer.from(bodyText, 'utf8');
    }
  }

  return bodyBuffer;
}

function formatApiError(err, context = 'Preview request failed') {
  const status = err.response?.status;
  const raw = err.response?.data;
  const contentType = String(err.response?.headers?.['content-type'] || '').toLowerCase();
  const prefix = status ? `${context} (${status})` : context;

  if (!raw) {
    return `${prefix}: ${err.message}`;
  }

  const asBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = asBuffer.toString('utf8').trim();

  if (!text) {
    return `${prefix}: Oracle returned an empty error response.`;
  }

  const looksJson = contentType.includes('application/json') || text.startsWith('{') || text.startsWith('[');
  if (looksJson) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length) {
        return `${prefix}: ${parsed.map((item) => String(item)).join(' | ')}`;
      }
      if (typeof parsed === 'string') {
        return `${prefix}: ${parsed}`;
      }
      if (parsed?.message) {
        return `${prefix}: ${parsed.message}`;
      }
      if (parsed?.error) {
        return `${prefix}: ${parsed.error}`;
      }
      return `${prefix}: ${JSON.stringify(parsed)}`;
    } catch {
      return `${prefix}: ${text}`;
    }
  }

  if (contentType.includes('text/html')) {
    const match = text.match(/<div id="errorMsg">\s*(.*?)\s*<\/div>/i);
    if (match?.[1]) {
      const clean = match[1].replace(/<[^>]+>/g, '').trim();
      if (clean) return `${prefix}: ${clean}`;
    }
    return `${prefix}: Oracle returned an HTML error page.`;
  }

  return `${prefix}: ${text}`;
}

function isXmlInputFile(inputPath, raw) {
  if (String(path.extname(inputPath)).toLowerCase() === '.xml') {
    return true;
  }

  return String(raw || '').trim().startsWith('<');
}

function minifyXml(xml) {
  return String(xml || '')
    .replace(/>\s+</g, '><')
    .trim();
}

async function getToken(baseUrl, username, password) {
  const loginUrl = `${baseUrl.replace(/\/$/, '')}/api/oauth2/v1/access`;
  const response = await axios.post(loginUrl, {
    User: username,
    Password: password,
  }, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });

  const token = response.data?.AccessToken;
  if (!token) {
    throw new Error('No token returned from Oracle login API.');
  }

  return token;
}

async function refreshSessionToken(session) {
  if (!session.username || !session.password) {
    throw new Error(
      'Token refresh requires OCCS_USERNAME and OCCS_PASSWORD (or OCCS_PASSWORD_ENC + OCCS_PASSWORD_KEY).',
    );
  }

  session.token = await getToken(session.baseUrl, session.username, session.password);
  saveSession({
    ...session,
    username: undefined,
    password: undefined,
  });
}

function parseConverterResponse(data) {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
  }
  if (data && typeof data === 'object') {
    return data;
  }
  throw new Error('XML converter returned an unsupported response payload.');
}

function prettifyPath(filePath) {
  const home = os.homedir();
  if (String(filePath).startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function resolveSessionWithCredentials(opts) {
  const session = loadSession();
  const resolved = resolveCredentialsWithSources(opts);

  return {
    ...session,
    username: resolved.credentials.username,
    password: resolved.credentials.password,
    credentialSources: resolved.sources,
    credentialEnvFiles: resolved.dotEnvFiles,
  };
}

async function postPreviewRequest(session, endpoint, body) {
  return await axios.post(endpoint, body, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: '*/*',
      'Content-Type': 'application/json',
    },
    responseType: 'arraybuffer',
    timeout: 30000,
  });
}

async function postPreviewWithRefresh(session, endpoint, body, opts) {
  try {
    return await postPreviewRequest(session, endpoint, body);
  } catch (err) {
    if (err.response?.status !== 401) {
      throw err;
    }

    if (opts.verbose) {
      console.log(chalk.yellow('⚠️ Preview token rejected (401). Attempting one automatic token refresh...'));
    }

    try {
      await refreshSessionToken(session);
    } catch (refreshErr) {
      const detail = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
      throw new Error(
        `Preview request failed (401) and automatic token refresh failed. ${detail} ` +
        'Stored credentials may be invalid; verify env credentials and run `occs login`.',
      );
    }

    return await postPreviewRequest(session, endpoint, body);
  }
}

export async function previewCommand(opts) {
  let session;
  try {
    session = resolveSessionWithCredentials(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`❌ Failed to load credentials: ${message}`));
    process.exit(1);
  }
  const inputPath = path.resolve(opts.input);
  const resolvedTarget = `${session.customer}.${session.region}/${session.tenancy}`;

  if (!fs.existsSync(inputPath)) {
    console.error(chalk.red(`❌ Input file not found: ${inputPath}`));
    process.exit(1);
  }

  const inputRaw = fs.readFileSync(inputPath, 'utf8');
  const isXmlInput = isXmlInputFile(inputPath, inputRaw);
  let escapedJson;

  const renderType = normalizeRenderType(opts.renderType);
  if (!RENDER_EXTENSIONS[renderType]) {
    console.error(chalk.red(`❌ Invalid render type: ${opts.renderType}`));
    console.error(chalk.gray('   Valid values: PDF, HTML, CSV, JSON, METADATA'));
    process.exit(1);
  }

  let effectiveDate;
  try {
    effectiveDate = getEffectiveDate(opts.effectiveDate);
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }

  const outputPath = resolveOutputPath(inputPath, opts.output, renderType);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const endpoint = `${session.baseUrl.replace(/\/$/, '')}/api/CommunicationAssembly/v1/CommunicationAssemblyRec`;

  if (isXmlInput) {
    if (!session.username || !session.password) {
      console.error(chalk.red('❌ XML preview requires OCCS_USERNAME and OCCS_PASSWORD (or OCCS_PASSWORD_ENC + OCCS_PASSWORD_KEY) to refresh token after XML conversion.'));
      process.exit(1);
    }

    const xmlMinified = minifyXml(inputRaw);
    const converterEndpoint = `${session.baseUrl.replace(/\/$/, '')}/api/CommunicationFileTransfer/v1/XmlToJsonConverter`;

    if (opts.verbose) {
      console.log(chalk.gray(`→ XML input detected: ${inputPath}`));
      console.log(chalk.gray(`→ POST ${converterEndpoint}`));
    }

    try {
      const conversionToken = await getToken(session.baseUrl, session.username, session.password);
      const converterResponse = await axios.post(converterEndpoint, {
        BatchConfigUuid: XML_TO_JSON_BATCH_CONFIG_UUID,
        XmlData: xmlMinified,
      }, {
        headers: {
          Authorization: `Bearer ${conversionToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      const convertedJson = parseConverterResponse(converterResponse.data);
      escapedJson = JSON.stringify(convertedJson);

      // Converter invalidates the token, so fetch a fresh token for preview API.
      session.token = await getToken(session.baseUrl, session.username, session.password);
    } catch (err) {
      console.error(chalk.red(`❌ ${formatApiError(err, 'XML conversion failed')}`));
      if (opts.verbose) {
        handleAxiosError(err, 'XML conversion failed');
      }
      process.exit(1);
    }
  } else {
    try {
      const inputJson = JSON.parse(inputRaw);
      escapedJson = JSON.stringify(inputJson);
    } catch (err) {
      console.error(chalk.red(`❌ Failed to parse input JSON: ${err.message}`));
      process.exit(1);
    }
  }

  const body = {
    CommunicationAssemblyInfo: {
      AssemblyRenderType: renderType,
      CommunicationPackageShortName: opts.packageName,
      CommunicationPackageConfigEffDt: effectiveDate,
      AssemblyData: escapedJson,
    },
  };

  if (opts.verbose) {
    console.log(chalk.gray(`→ Target: ${resolvedTarget}`));
    console.log(chalk.gray(`→ BaseUrl: ${session.baseUrl}`));
    console.log(chalk.gray('→ Target source: session (~/.occs-session.json)'));
    console.log(chalk.gray(`→ Credential source (username): ${session.credentialSources?.username || 'unset'}`));
    console.log(chalk.gray(`→ Credential source (password): ${session.credentialSources?.password || 'unset'}`));
    if (Array.isArray(session.credentialEnvFiles) && session.credentialEnvFiles.length > 0) {
      const files = session.credentialEnvFiles.map(prettifyPath).join(', ');
      console.log(chalk.gray(`→ Env files considered: ${files}`));
    } else {
      console.log(chalk.gray('→ Env files considered: none found'));
    }
    console.log(chalk.gray(`→ POST ${endpoint}`));
    console.log(chalk.gray(`→ RenderType: ${renderType}`));
    console.log(chalk.gray(`→ EffectiveDate: ${effectiveDate}`));
    console.log(chalk.gray(`→ Output: ${outputPath}`));
  }

  try {
    const response = await postPreviewWithRefresh(session, endpoint, body, opts);

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const outputBuffer = decodeResponseBody(response.data, contentType);
    fs.writeFileSync(outputPath, outputBuffer);

    console.log(chalk.green(`✅ Preview written to ${outputPath}`));
  } catch (err) {
    const errMessage = err instanceof Error && !err.response
      ? err.message
      : formatApiError(err, 'Preview request failed');
    console.error(chalk.red(`❌ ${errMessage}`));
    if (opts.verbose) {
      handleAxiosError(err, 'Preview request failed');
    }
    process.exit(1);
  }
}
