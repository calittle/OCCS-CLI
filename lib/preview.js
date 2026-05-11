import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { loadSession } from './session.js';
import { handleAxiosError } from './errorHandler.js';

const RENDER_EXTENSIONS = {
  PDF: '.pdf',
  HTML: '.html',
  CSV: '.csv',
  JSON: '.json',
  METADATA: '.json',
};

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

function formatPreviewError(err) {
  const status = err.response?.status;
  const raw = err.response?.data;
  const contentType = String(err.response?.headers?.['content-type'] || '').toLowerCase();
  const prefix = status ? `Preview request failed (${status})` : 'Preview request failed';

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

export async function previewCommand(opts) {
  const session = loadSession();
  const inputPath = path.resolve(opts.input);

  if (!fs.existsSync(inputPath)) {
    console.error(chalk.red(`❌ Input file not found: ${inputPath}`));
    process.exit(1);
  }

  let inputJson;
  try {
    inputJson = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    console.error(chalk.red(`❌ Failed to parse input JSON: ${err.message}`));
    process.exit(1);
  }

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

  const escapedJson = JSON.stringify(inputJson);
  const endpoint = `${session.baseUrl.replace(/\/$/, '')}/api/CommunicationAssembly/v1/CommunicationAssemblyRec`;

  const body = {
    CommunicationAssemblyInfo: {
      AssemblyRenderType: renderType,
      CommunicationPackageShortName: opts.packageName,
      CommunicationPackageConfigEffDt: effectiveDate,
      AssemblyData: escapedJson,
    },
  };

  if (opts.verbose) {
    console.log(chalk.gray(`→ POST ${endpoint}`));
    console.log(chalk.gray(`→ RenderType: ${renderType}`));
    console.log(chalk.gray(`→ EffectiveDate: ${effectiveDate}`));
    console.log(chalk.gray(`→ Output: ${outputPath}`));
  }

  try {
    const response = await axios.post(endpoint, body, {
      headers: {
        Authorization: `Bearer ${session.token}`,
        Accept: '*/*',
        'Content-Type': 'application/json',
      },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const outputBuffer = decodeResponseBody(response.data, contentType);
    fs.writeFileSync(outputPath, outputBuffer);

    console.log(chalk.green(`✅ Preview written to ${outputPath}`));
  } catch (err) {
    console.error(chalk.red(`❌ ${formatPreviewError(err)}`));
    if (opts.verbose) {
      handleAxiosError(err, 'Preview request failed');
    }
    process.exit(1);
  }
}
