import { randomUUID } from 'node:crypto';

export const HTTP_TRACE_PREFIX = '@OCCS_HTTP@';
const secretKey = /authorization|cookie|password|credential|token|secret|api.?key|private.?key/i;
const personalKey = /^(?:firstName|lastName|fullName|customerName|phone|telephone|address|accountNumber|accountId|acctId|personId|contactId|customerId|customerContactId|phoneNumber|postalCode|username)$/i;
const inputKey = /^(?:CommunicationData|AssemblyData)$/i;
const contentKey = /^(?:AssemblyRenderOutput|html|htmlBody|documentContent|fileContent|attachmentContent|attachmentData|contentBase64)$/i;

const addressKey = /^(?:contactValue|email|emailAddress|recipient|recipients|to|cc|bcc)$/i;
const visibleInputKey = /^(?:templateName|deliveryType|language|key)$/i;

export function maskEmailAddress(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(item => maskEmailAddress(item));
  if (typeof value !== 'string') return `[invalid address: ${typeof value}]`;
  if (!value.trim()) return '[empty address]';
  if (/^\[(?:invalid address: .*|empty address|redacted)\]$/.test(value)) return value;
  return value.split(/([,;])/).map(part => {
    if (part === ',' || part === ';') return part;
    const text = part.trim();
    if (!text) return '[empty address]';
    const at = text.lastIndexOf('@');
    const local = at >= 0 ? text.slice(0, at) : text;
    const domain = at >= 0 ? text.slice(at + 1) : '';
    if (/^.{1,2}\*{3}$/.test(local) && /^[^\s@]+\.[^\s@]+$/.test(domain)) return text;
    const prefix = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
    if (/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(text)) return `${prefix}***@${domain}`;
    // Preserve whether it was empty/malformed and its length, without leaking an
    // arbitrary customer value supplied in an address field.
    return `[invalid address: ${text.length} chars, starts ${JSON.stringify(prefix)}${at >= 0 ? ', contains @' : ', no @'}]`;
  }).join('');
}

function maskedScalar(value) {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (/^\[(?:masked: (?:string|number|boolean), \d+ chars|redacted)\]$/.test(value)) return value;
    if (/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value)) return maskEmailAddress(value);
  }
  return `[masked: ${typeof value}, ${String(value).length} chars]`;
}

function safeText(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, safeUrl)
    .replace(/(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, '[redacted]')
    .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi, match => maskEmailAddress(match))
    .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[redacted]');
}

function maskInput(value, depth = 0, key = '') {
  if (secretKey.test(key)) return '[redacted]';
  if (addressKey.test(key)) return maskEmailAddress(value);
  if (visibleInputKey.test(key) && typeof value === 'string') return safeText(value);
  if (depth > 30) return '[omitted: depth limit]';
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => maskInput(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200)
    .map(([key, item]) => [safeText(key), maskInput(item, depth + 1, key)]));
  return maskedScalar(value);
}

export function sanitizeHttpValue(value, key = '', depth = 0) {
  if (secretKey.test(key)) return '[redacted]';
  if (addressKey.test(key)) return maskEmailAddress(value);
  if (personalKey.test(key)) return '[redacted]';
  if (inputKey.test(key)) {
    try { return typeof value === 'string' ? JSON.stringify(maskInput(JSON.parse(value))) : maskInput(value); }
    catch { return '[redacted: input data]'; }
  }
  if (contentKey.test(key)) return `[omitted: rendered/file content, ${String(value ?? '').length} characters]`;
  if (depth > 30) return '[omitted: depth limit]';
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (buffer.length > 262144) return `[omitted: body exceeds 256 KiB, ${buffer.length} bytes]`;
    try { return sanitizeHttpValue(JSON.parse(buffer.toString('utf8')), '', depth + 1); }
    catch { return `[omitted: non-JSON body, ${buffer.length} bytes]`; }
  }
  if (typeof value === 'string') {
    if (value.length > 262144) return `[omitted: value exceeds 256 KiB, ${value.length} characters]`;
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return sanitizeHttpValue(parsed, '', depth + 1);
    } catch { /* Plain diagnostic text. */ }
    if (/<(?:!doctype|html|body)\b|data:image\//i.test(value)) return `[omitted: rendered content, ${value.length} characters]`;
    return safeText(value);
  }
  if (Array.isArray(value)) {
    const values = value.slice(0, 100).map(item => sanitizeHttpValue(item, '', depth + 1));
    if (value.length > 100) values.push(`[omitted: ${value.length - 100} more items]`);
    return values;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200)
      .map(([name, item]) => [safeText(name), sanitizeHttpValue(item, name, depth + 1)]));
  }
  return value;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = '';
    url.pathname = url.pathname.replace(/\/p\/[^/]+(?=\/n\/)/, '/p/[redacted]');
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
    return url.toString();
  } catch { return '[invalid URL]'; }
}

function emit(value) {
  const text = JSON.stringify(value);
  // Never truncate JSON mid-value: preserve a parseable event and make omissions explicit.
  process.stderr.write(HTTP_TRACE_PREFIX + (text.length <= 524288 ? text : JSON.stringify({
    id: value.id, type: value.type, method: value.method, url: value.url, status: value.status,
    body: '[omitted: sanitized trace exceeds 512 KiB]',
  })) + '\n');
}

/** Trace each HTTP attempt without changing stdout, return values or retry behavior. */
export async function tracedHttp(config, send, { enabled = true } = {}) {
  if (!enabled || process.env.OCCS_HTTP_DEBUG !== '1') return send();
  const id = randomUUID();
  const method = String(config.method || 'GET').toUpperCase();
  const url = safeUrl(config.url);
  emit({ id, type: 'request', method, url, headers: sanitizeHttpValue(config.headers || {}),
    params: maskInput(config.params || {}), body: sanitizeHttpValue(config.data ?? null) });
  const started = Date.now();
  try {
    const response = await send();
    emit({ id, type: 'response', method, url, status: response.status,
      durationMs: Date.now() - started, headers: sanitizeHttpValue(response.headers || {}),
      body: sanitizeHttpValue(response.data) });
    return response;
  } catch (error) {
    emit({ id, type: 'response', method, url, status: error.response?.status ?? null,
      durationMs: Date.now() - started, headers: sanitizeHttpValue(error.response?.headers || {}),
      body: sanitizeHttpValue(error.response?.data ?? null),
      error: { code: error.code || '', message: safeText(error.message) } });
    throw error;
  }
}
