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
const DEFAULT_PREVIEW_TIMEOUT_MS = 30000;

function ringBell(count = 1) {
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  process.stdout.write('\x07'.repeat(safeCount));
}

function exitWithErrorBell() {
  ringBell(2);
  process.exit(1);
}

function normalizeRenderType(value) {
  return String(value ?? 'PDF').trim().toUpperCase();
}

function parseRenderTypes(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const parsed = rawValues
    .flatMap((item) => String(item ?? '').split(','))
    .map((item) => normalizeRenderType(item))
    .filter(Boolean);

  if (parsed.length === 0) {
    return ['PDF'];
  }

  return [...new Set(parsed)];
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function resolveRequestTimeoutMs(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return DEFAULT_PREVIEW_TIMEOUT_MS;
  }
  const timeout = Number(rawValue);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid --timeout value. Provide a positive number in milliseconds (for example 60000).');
  }
  return Math.floor(timeout);
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
    return path.join(process.cwd(), `${parsedInput.name}${extension}`);
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

function resolveOutputPlans(inputPath, outputPath, renderTypes) {
  const plans = [];
  const usedPaths = new Set();

  for (const renderType of renderTypes) {
    const baseOutputPath = resolveOutputPath(inputPath, outputPath, renderType);
    let candidate = baseOutputPath;

    if (usedPaths.has(candidate)) {
      const parsed = path.parse(baseOutputPath);
      candidate = path.join(parsed.dir, `${parsed.name}.${String(renderType).toLowerCase()}${parsed.ext || (RENDER_EXTENSIONS[renderType] || '.bin')}`);
    }

    usedPaths.add(candidate);
    plans.push({
      renderType,
      outputPath: candidate,
    });
  }

  return plans;
}

function isLikelyBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function decodeMaybeBase64(value) {
  const normalized = String(value)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\\//g, '/')
    .replace(/\\n|\\r/g, '')
    .replace(/\s+/g, '');
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

function extractRenderOutputPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const preferred = payload?.CommunicationAssemblyInfo?.AssemblyRenderOutput;
  if (typeof preferred === 'string' && preferred.trim()) {
    return preferred;
  }

  return extractStringPayload(payload);
}

function looksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return false;
  }

  let start = 0;
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    start = 3;
  }

  while (start < buffer.length && /\s/.test(String.fromCharCode(buffer[start]))) {
    start += 1;
  }

  return buffer.slice(start, start + 5).toString('ascii') === '%PDF-';
}

function decodeResponseBody(rawData, contentType, renderType) {
  const bodyBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData || '');

  if (!(contentType.includes('application/json') || contentType.includes('text/'))) {
    return bodyBuffer;
  }

  const bodyText = bodyBuffer.toString('utf8').trim();
  if (!bodyText) {
    return bodyBuffer;
  }

  const candidates = [];
  const addCandidate = (value) => {
    if (typeof value === 'string' && value.trim()) {
      candidates.push(value);
    }
  };

  addCandidate(bodyText);
  try {
    const parsed = JSON.parse(bodyText);
    if (typeof parsed === 'string') {
      addCandidate(parsed);
    } else {
      addCandidate(extractStringPayload(parsed));
    }
  } catch {
    // Not JSON; bodyText candidate already added.
  }

  const uniqueCandidates = [...new Set(candidates)];
  const decodedCandidates = uniqueCandidates
    .map((candidate) => decodeMaybeBase64(candidate))
    .filter(Boolean);

  if (renderType === 'PDF') {
    const pdfCandidate = decodedCandidates.find((candidate) => looksLikePdf(candidate));
    if (pdfCandidate) {
      return pdfCandidate;
    }

    if (looksLikePdf(bodyBuffer)) {
      return bodyBuffer;
    }

    return decodedCandidates[0] || Buffer.from(uniqueCandidates[0], 'utf8');
  }

  if (decodedCandidates.length > 0) {
    return decodedCandidates[0];
  }

  return Buffer.from(uniqueCandidates[0], 'utf8');
}

function ensureOutputMatchesRenderType(renderType, outputBuffer, contentType) {
  if (renderType !== 'PDF') {
    return;
  }

  if (looksLikePdf(outputBuffer)) {
    return;
  }

  const snippet = outputBuffer
    .toString('utf8', 0, Math.min(120, outputBuffer.length))
    .replace(/\s+/g, ' ')
    .trim();

  throw new Error(
    `Preview response did not decode to a valid PDF. Content-Type was "${contentType || 'unknown'}". ` +
    (snippet ? `Payload starts with: ${snippet}` : 'Payload was empty.'),
  );
}

function parseResponseJson(rawData, contentType) {
  const bodyBuffer = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData || '');
  if (!(contentType.includes('application/json') || contentType.includes('text/'))) {
    return null;
  }

  const bodyText = bodyBuffer.toString('utf8').trim();
  if (!bodyText) return null;

  try {
    const parsed = JSON.parse(bodyText);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getSidecarPath(outputPath, suffix) {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.name}.${suffix}`);
}

function savePreviewErrorSidecar(err, outputPath) {
  const status = err?.response?.status;
  const raw = err?.response?.data;
  if (!status || !raw) return null;

  const contentType = String(err?.response?.headers?.['content-type'] || '').toLowerCase();
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = buffer.toString('utf8');

  if (contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const sidecarPath = getSidecarPath(outputPath, `response.error.${status}.json`);
      fs.writeFileSync(sidecarPath, JSON.stringify(parsed, null, 2));
      return sidecarPath;
    } catch {
      // fall through to raw text file
    }
  }

  const sidecarPath = getSidecarPath(outputPath, `response.error.${status}.txt`);
  fs.writeFileSync(sidecarPath, text || String(raw));
  return sidecarPath;
}

function applyJsonReroot(convertedJson, shouldReroot, newRoot) {
  if (!shouldReroot || !newRoot || !convertedJson || typeof convertedJson !== 'object' || Array.isArray(convertedJson)) {
    return convertedJson;
  }

  // Desired output for reroot is always top-level { <newRoot>: ... }
  // (no outer "root" wrapper).
  const root = convertedJson.root;
  if (root && typeof root === 'object' && !Array.isArray(root)) {
    if (Object.prototype.hasOwnProperty.call(root, newRoot)) {
      return {
        [newRoot]: root[newRoot],
      };
    }

    return {
      [newRoot]: root,
    };
  }

  if (Object.prototype.hasOwnProperty.call(convertedJson, newRoot)) {
    return {
      [newRoot]: convertedJson[newRoot],
    };
  }

  return {
    [newRoot]: convertedJson,
  };
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getXmlLocalName(tagName) {
  const raw = String(tagName || '').trim();
  const idx = raw.lastIndexOf(':');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

function findXmlTagRangesByLocalName(xml, targetLocalName) {
  const source = String(xml || '');
  const target = String(targetLocalName || '').trim();
  if (!target) {
    return [];
  }

  const tagRegex = /<\s*(\/?)\s*([A-Za-z_][\w.\-:]*)\b([^>]*)>/g;
  let match;
  let currentStartIndex = -1;
  let depth = 0;
  const ranges = [];
  const lowerTarget = target.toLowerCase();

  while ((match = tagRegex.exec(source)) !== null) {
    const fullTag = match[0];
    const isClosing = Boolean(match[1]);
    const rawTagName = match[2];
    const localName = getXmlLocalName(rawTagName).toLowerCase();
    const isSelfClosing = /\/\s*>$/.test(fullTag);

    if (localName !== lowerTarget) {
      continue;
    }

    if (!isClosing && depth === 0) {
      currentStartIndex = match.index;
    }

    if (!isClosing) {
      if (isSelfClosing) {
        if (depth === 0 && currentStartIndex >= 0) {
          ranges.push({ start: currentStartIndex, end: tagRegex.lastIndex });
          currentStartIndex = -1;
        }
      } else {
        depth += 1;
      }
      continue;
    }

    if (isClosing && depth > 0) {
      depth -= 1;
      if (depth === 0 && currentStartIndex >= 0) {
        ranges.push({ start: currentStartIndex, end: tagRegex.lastIndex });
        currentStartIndex = -1;
      }
    }
  }

  return ranges;
}

function findXmlSubtreeByLocalName(xml, targetLocalName) {
  const source = String(xml || '');
  const target = String(targetLocalName || '').trim();
  const ranges = findXmlTagRangesByLocalName(source, target);

  if (ranges.length === 0) {
    throw new Error(`Could not find XML element "${target}" to reroot.`);
  }

  if (ranges.length > 1) {
    throw new Error(`Multiple XML elements matched "${target}" (${ranges.length} found). Use a unique element name.`);
  }

  return source.slice(ranges[0].start, ranges[0].end);
}

function parseExtractExpression(expression) {
  const raw = String(expression || '').trim();
  const parts = raw.split('==');

  if (!raw || parts.length !== 2) {
    throw new Error('Invalid `--extract` expression. Use format fieldName==value (for example billId==002051606115).');
  }

  const field = parts[0].trim();
  const value = parts[1].trim();

  if (!field || !value) {
    throw new Error('Invalid `--extract` expression. Both field name and value are required.');
  }

  return { field, value };
}

function recordContainsFieldValue(xml, fieldName, expectedValue) {
  const field = escapeRegex(fieldName);
  const value = escapeRegex(expectedValue);
  const pattern = new RegExp(
    `<\\s*(?:[A-Za-z_][\\w.\\-]*:)?${field}\\b[^>]*>\\s*${value}\\s*<\\s*\\/\\s*(?:[A-Za-z_][\\w.\\-]*:)?${field}\\s*>`,
    'i',
  );
  return pattern.test(xml);
}

function extractSingleBatchRecord(xml, expression, recordTag = 'C1-BillPrintRecord') {
  const { field, value } = parseExtractExpression(expression);
  const source = String(xml || '');
  const ranges = findXmlTagRangesByLocalName(source, recordTag);
  const candidates = ranges.length > 0
    ? ranges.map((range) => source.slice(range.start, range.end))
    : [source];

  const matched = candidates.filter((candidate) => recordContainsFieldValue(candidate, field, value));

  if (matched.length === 0) {
    throw new Error(`No XML record matched \`${field}==${value}\` within ${recordTag} entries.`);
  }
  if (matched.length > 1) {
    throw new Error(`Multiple XML records matched \`${field}==${value}\` (${matched.length} found).`);
  }

  return matched[0];
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

async function postPreviewRequest(session, endpoint, body, timeoutMs) {
  return await axios.post(endpoint, body, {
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: '*/*',
      'Content-Type': 'application/json',
    },
    responseType: 'arraybuffer',
    timeout: timeoutMs,
  });
}

async function postPreviewWithRefresh(session, endpoint, body, opts, timeoutMs) {
  try {
    return await postPreviewRequest(session, endpoint, body, timeoutMs);
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

    return await postPreviewRequest(session, endpoint, body, timeoutMs);
  }
}

export async function previewCommand(opts) {
  let session;
  try {
    session = resolveSessionWithCredentials(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`❌ Failed to load credentials: ${message}`));
    exitWithErrorBell();
  }
  const inputPath = path.resolve(opts.input);
  const resolvedTarget = `${session.customer}.${session.region}/${session.tenancy}`;

  if (!fs.existsSync(inputPath)) {
    console.error(chalk.red(`❌ Input file not found: ${inputPath}`));
    exitWithErrorBell();
  }

  const inputRaw = fs.readFileSync(inputPath, 'utf8');
  const isXmlInput = isXmlInputFile(inputPath, inputRaw);
  const extractExpression = String(opts.extract ?? '').trim();
  const rerootTarget = String(opts.reroot ?? '').trim();
  const shouldReroot = Boolean(rerootTarget);
  let timeoutMs;
  try {
    timeoutMs = resolveRequestTimeoutMs(opts.timeout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`❌ ${message}`));
    exitWithErrorBell();
  }
  let escapedJson;

  const renderTypes = parseRenderTypes(opts.renderType);
  const invalidRenderTypes = renderTypes.filter((renderType) => !RENDER_EXTENSIONS[renderType]);
  if (invalidRenderTypes.length > 0) {
    console.error(chalk.red(`❌ Invalid render type(s): ${invalidRenderTypes.join(', ')}`));
    console.error(chalk.gray('   Valid values: PDF, HTML, CSV, JSON, METADATA'));
    exitWithErrorBell();
  }

  let effectiveDate;
  try {
    effectiveDate = getEffectiveDate(opts.effectiveDate);
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    exitWithErrorBell();
  }

  const outputPlans = resolveOutputPlans(inputPath, opts.output, renderTypes);
  for (const plan of outputPlans) {
    fs.mkdirSync(path.dirname(plan.outputPath), { recursive: true });
  }

  const endpoint = `${session.baseUrl.replace(/\/$/, '')}/api/CommunicationAssembly/v1/CommunicationAssemblyRec`;

  if (isXmlInput) {
    if (!session.username || !session.password) {
      console.error(chalk.red('❌ XML preview requires OCCS_USERNAME and OCCS_PASSWORD (or OCCS_PASSWORD_ENC + OCCS_PASSWORD_KEY) to refresh token after XML conversion.'));
      exitWithErrorBell();
    }

    let xmlSource = inputRaw;
    if (extractExpression) {
      try {
        xmlSource = extractSingleBatchRecord(xmlSource, extractExpression);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`❌ ${message}`));
        exitWithErrorBell();
      }
    }

    if (shouldReroot) {
      try {
        xmlSource = findXmlSubtreeByLocalName(xmlSource, rerootTarget);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`❌ ${message}`));
        exitWithErrorBell();
      }
    }

    const xmlMinified = minifyXml(xmlSource);
    const converterEndpoint = `${session.baseUrl.replace(/\/$/, '')}/api/CommunicationFileTransfer/v1/XmlToJsonConverter`;

    if (opts.verbose) {
      console.log(chalk.gray(`→ XML input detected: ${inputPath}`));
      if (extractExpression) {
        console.log(chalk.gray(`→ XML extract: ${extractExpression}`));
      } else {
        console.log(chalk.gray('→ XML extract: disabled'));
      }
      if (shouldReroot) {
        console.log(chalk.gray(`→ XML reroot: enabled (new root: ${rerootTarget})`));
      } else {
        console.log(chalk.gray('→ XML reroot: disabled'));
      }
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
        timeout: timeoutMs,
      });

      const convertedJsonRaw = parseConverterResponse(converterResponse.data);
      const convertedJson = applyJsonReroot(convertedJsonRaw, shouldReroot, rerootTarget);
      escapedJson = JSON.stringify(convertedJson);

      const generatedInputJsonPath = getSidecarPath(outputPlans[0].outputPath, 'generated-input.json');
      fs.writeFileSync(generatedInputJsonPath, JSON.stringify(convertedJson, null, 2));
      if (opts.verbose) {
        console.log(chalk.gray(`→ Generated input JSON: ${generatedInputJsonPath}`));
      }

      // Converter invalidates the token, so fetch a fresh token for preview API.
      session.token = await getToken(session.baseUrl, session.username, session.password);
    } catch (err) {
      console.error(chalk.red(`❌ ${formatApiError(err, 'XML conversion failed')}`));
      if (opts.verbose) {
        handleAxiosError(err, 'XML conversion failed');
      }
      exitWithErrorBell();
    }
  } else {
    try {
      const inputJson = JSON.parse(inputRaw);
      escapedJson = JSON.stringify(inputJson);
    } catch (err) {
      console.error(chalk.red(`❌ Failed to parse input JSON: ${err.message}`));
      exitWithErrorBell();
    }
  }

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
    console.log(chalk.gray(`→ RenderTypes: ${renderTypes.join(', ')}`));
    console.log(chalk.gray(`→ EffectiveDate: ${effectiveDate}`));
    console.log(chalk.gray(`→ TimeoutMs: ${timeoutMs}`));
    for (const plan of outputPlans) {
      console.log(chalk.gray(`→ Output[${plan.renderType}]: ${plan.outputPath}`));
    }
  }

  const runPreviewForType = async ({ renderType, outputPath }) => {
    const requestSession = { ...session };
    const body = {
      CommunicationAssemblyInfo: {
        AssemblyRenderType: renderType,
        CommunicationPackageShortName: opts.packageName,
        CommunicationPackageConfigEffDt: effectiveDate,
        AssemblyData: escapedJson,
      },
    };

    const response = await postPreviewWithRefresh(requestSession, endpoint, body, opts, timeoutMs);
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const responseJson = parseResponseJson(response.data, contentType);

    let outputBuffer;
    if (responseJson) {
      const payloadString = extractRenderOutputPayload(responseJson);
      if (typeof payloadString === 'string' && payloadString.trim()) {
        outputBuffer = decodeMaybeBase64(payloadString) || Buffer.from(payloadString, 'utf8');
      } else {
        outputBuffer = decodeResponseBody(response.data, contentType, renderType);
      }
    } else {
      outputBuffer = decodeResponseBody(response.data, contentType, renderType);
    }

    ensureOutputMatchesRenderType(renderType, outputBuffer, contentType);
    fs.writeFileSync(outputPath, outputBuffer);

    let responseJsonPath = null;
    if (responseJson) {
      responseJsonPath = getSidecarPath(outputPath, 'response.json');
      fs.writeFileSync(responseJsonPath, JSON.stringify(responseJson, null, 2));
    }

    return { renderType, outputPath, responseJsonPath };
  };

  const settled = await Promise.allSettled(outputPlans.map(runPreviewForType));
  const failures = settled
    .map((result, index) => ({ result, plan: outputPlans[index] }))
    .filter(({ result }) => result.status === 'rejected');
  const successes = settled
    .map((result, index) => ({ result, plan: outputPlans[index] }))
    .filter(({ result }) => result.status === 'fulfilled');

  for (const success of successes) {
    const payload = success.result.value;
    if (payload.responseJsonPath && opts.verbose) {
      console.log(chalk.gray(`→ Response JSON[${payload.renderType}]: ${payload.responseJsonPath}`));
    }
    console.log(chalk.green(`✅ Preview written [${payload.renderType}] to ${payload.outputPath}`));
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const err = failure.result.reason;
      const errorSidecarPath = err?.response?.status === 400
        ? savePreviewErrorSidecar(err, failure.plan.outputPath)
        : null;
      const errMessage = err instanceof Error && !err.response
        ? err.message
        : formatApiError(err, 'Preview request failed');
      console.error(chalk.red(`❌ [${failure.plan.renderType}] ${errMessage}`));
      if (errorSidecarPath) {
        console.error(chalk.yellow(`⚠ Saved detailed preview error response to ${errorSidecarPath}`));
      }
      if (opts.verbose && err?.response?.status !== 400) {
        handleAxiosError(err, `Preview request failed [${failure.plan.renderType}]`);
      }
    }
    exitWithErrorBell();
  }

  if (opts.ding) {
    ringBell(1);
  }
}
