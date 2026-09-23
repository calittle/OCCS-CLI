import { loadSession } from './session.js';
import { get, mutateJson, paginate, postMultipart } from './api.js';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency, writeStdoutJSON } from './utils.js';
import { downloadBlob } from './download.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';
import { resolveOpenConfigId } from './configs.js';

const CONTENT_API = '/api/CommunicationContent/v1';
const STYLE_API = '/api/CommunicationDocument/v1';
const DEFAULT_CONTENT_LANGUAGE = 'en-US';

function optsWithGlobals(cmd) {
  return typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : (cmd || {});
}

function sessionSelector(opts = {}) {
  return {
    sessionName: opts.session,
    customer: opts.customer,
    region: opts.region ?? opts.environment,
    tenancy: opts.tenancy,
  };
}

function configLabel(config) {
  return config.shortName || config.name || config.input;
}

function writeResult(opts, value, lines) {
  if (opts.json) {
    writeStdoutJSON(value);
    return;
  }
  console.log(lines.join('\n'));
}

/** Return only safe, actionable OCCS error fields—never Axios request internals. */
export function contentCommandErrorSummary(error) {
  const response = error?.response;
  const payload = response?.data || {};
  return {
    message: String(payload.message || payload.failureReason || error?.message || 'Content command failed.'),
    ...(response?.status ? { status: response.status } : {}),
    ...(payload.executionId || response?.headers?.executionid ? { executionId: payload.executionId || response.headers.executionid } : {}),
  };
}

async function runContentCommand(opts, action) {
  try {
    return await action();
  } catch (error) {
    const summary = contentCommandErrorSummary(error);
    if (opts.json) {
      writeStdoutJSON({ ok: false, error: summary });
    } else {
      console.error(`❌ ${summary.message}`);
      if (summary.status) console.error(`HTTP ${summary.status}${summary.executionId ? ` · Execution ID: ${summary.executionId}` : ''}`);
    }
    process.exit(1);
  }
}

function requireValue(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function occsDate(value, label) {
  const date = requireValue(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${label} must be YYYY-MM-DD.`);
  }
  return `${date}T00:00:00.000000Z`;
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function status(statusCode, effectiveDate) {
  return { StatusCode: statusCode, EffDtTm: occsDate(effectiveDate, 'Effective date') };
}

function collectionItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.Items)) return value.Items;
  return value ? [value] : [];
}

export function buildCreateContentPayload({
  shortName,
  name = shortName,
  description = '',
  contentType = 'Text',
  version = '1.0',
  effectiveDate,
  styleClasses = [],
}) {
  const normalizedShortName = requireValue(shortName, 'Content short name');
  return {
    CommunicationContentConfigRec: {
      CommunicationContentConfigInfo: {
        Name: requireValue(name, 'Content name'),
        ShortName: normalizedShortName,
        Desc: String(description ?? ''),
        ContentType: requireValue(contentType, 'Content type'),
      },
      Status: [status('Active', effectiveDate)],
    },
    CommunicationContentVersionConfigRec: {
      CommunicationContentVersionConfigInfo: {
        ShortName: requireValue(version, 'Version'),
        Desc: '',
        Language: DEFAULT_CONTENT_LANGUAGE,
        CommunicationContentVersionConfigData: [{ StyleClassName: styleClasses }],
        CommunicationContentConfigUuid: 'DUMMY',
      },
      Status: [status('Active', effectiveDate)],
    },
    CommunicationContentVersionStyles: [],
  };
}

export function buildCreateVersionPayload({
  contentUuid,
  version,
  effectiveDate,
  styleClasses = [],
  versionStyles = [],
  configId,
}) {
  const data = { StyleClassName: styleClasses };
  if (configId) data.ConfigId = String(configId);
  const info = {
    ShortName: requireValue(version, 'Version'),
    Desc: '',
    Language: DEFAULT_CONTENT_LANGUAGE,
    CommunicationContentVersionConfigData: [data],
    CommunicationContentConfigUuid: requireValue(contentUuid, 'Content UUID'),
  };
  if (configId) info.ConfigId = String(configId);
  return {
    CommunicationContentVersionConfigRec: {
      CommunicationContentVersionConfigInfo: info,
      Status: [status('Active', effectiveDate)],
    },
    CommunicationContentVersionStyles: versionStyles,
  };
}

export function buildVersionMasterUpdatePayload({ createdVersion, contentRecord, configId, versionStyles, inProgressDate = todayUtcDate() }) {
  const versionRecord = createdVersion?.CommunicationContentVersionConfigRec;
  if (!versionRecord?.CommunicationContentVersionConfigInfo) {
    throw new Error('OCCS did not return a content-version record after creation.');
  }
  if (!contentRecord?.CommunicationContentConfigInfo) {
    throw new Error('OCCS did not return a content record needed to open the new version.');
  }
  const withConfigId = (record) => ({ ...record, ConfigId: String(configId) });
  const versionInfo = versionRecord.CommunicationContentVersionConfigInfo;
  return {
    CommunicationContentVersionConfigRec: {
      ...versionRecord,
      CommunicationContentVersionConfigInfo: {
        ...withConfigId(versionInfo),
        // POST responds with a paged { Items } envelope; PUT expects the
        // plain array emitted by the Comms UI. The envelope mismatches that
        // update contract and may prevent a subsequent ContentData upload.
        CommunicationContentVersionConfigData: collectionItems(versionInfo.CommunicationContentVersionConfigData).map(withConfigId),
      },
      Status: [
        { StatusCode: 'In Progress', EffDtTm: occsDate(inProgressDate, 'In-progress date'), ConfigId: String(configId) },
        // OCCS POST already returns an In Progress row. Replace it with the
        // explicit current-date row rather than sending it twice; the UI PUT
        // contains only In Progress followed by Active/Inactive transitions.
        ...collectionItems(versionRecord.Status)
          .filter((entry) => String(entry?.StatusCode || '').toLowerCase() !== 'in progress')
          .map(withConfigId),
      ],
    },
    CommunicationContentVersionStyles: versionStyles === undefined
      ? collectionItems(createdVersion.CommunicationContentVersionStyles)
      : collectionItems(versionStyles),
    CommunicationContentConfigRec: {
      ...contentRecord,
      CommunicationContentConfigInfo: withConfigId(contentRecord.CommunicationContentConfigInfo),
      Status: (contentRecord.Status?.Items || contentRecord.Status || []).map(withConfigId),
      ConfigId: String(configId),
    },
  };
}

/**
 * The Comms editor persists italic text as <i>, and its content endpoint
 * silently drops semantic <em> markup. Match the editor before uploading so
 * authored HTML retains emphasis after OCCS stores it.
 */
export function normalizeContentHtml(html) {
  return String(html)
    .replace(/<em(\s[^>]*)?>/gi, (_match, attributes = '') => `<i${attributes}>`)
    .replace(/<\/em\s*>/gi, '</i>');
}

export function buildContentBlobMultipart(html) {
  const boundary = `----occs-cli-${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name=""; filename="blob"',
    'Content-Type: application/octet-stream',
    '',
    normalizeContentHtml(html),
    `--${boundary}--`,
    '',
  ].join('\r\n'), 'utf8');
  return { boundary, body };
}

function readHtmlFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read HTML file ${filePath}: ${err.message}`);
  }
}

function versionUuid(response) {
  return response?.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigUuid;
}

function contentUuid(response) {
  return response?.CommunicationContentConfigRec?.CommunicationContentConfigUuid;
}

export function resolveSourceContentVersion(contentMaster, requestedVersion) {
  const wanted = requireValue(requestedVersion, 'Source version').toLowerCase();
  const matches = collectionItems(contentMaster?.CommunicationContentMasterVersions)
    .map((entry) => entry?.CommunicationContentVersionConfigRec || entry || {})
    .filter((record) => String(record?.CommunicationContentVersionConfigInfo?.ShortName || '').toLowerCase() === wanted);
  if (matches.length === 1) return matches[0];
  const available = collectionItems(contentMaster?.CommunicationContentMasterVersions)
    .map((entry) => entry?.CommunicationContentVersionConfigRec || entry || {})
    .map((record) => record?.CommunicationContentVersionConfigInfo?.ShortName)
    .filter(Boolean);
  if (matches.length > 1) throw new Error(`Content version is ambiguous: ${requestedVersion}`);
  throw new Error(`Content version not found: ${requestedVersion}.${available.length ? ` Available versions: ${available.join(', ')}.` : ''}`);
}

export function buildCopiedVersionStyles(sourceStyles, configId) {
  return collectionItems(sourceStyles)
    .map((entry) => entry?.CommunicationStyleConfigCommunicationContentVersionConfigRelRec
      ?.CommunicationStyleConfigCommunicationContentVersionConfigRelInfo)
    .filter((info) => info?.CommunicationStyleConfigUuid)
    .map((info) => ({
      CommunicationStyleConfigCommunicationContentVersionConfigRelRec: {
        CommunicationStyleConfigCommunicationContentVersionConfigRelInfo: {
          CommunicationStyleConfigUuid: info.CommunicationStyleConfigUuid,
          StyleRelIndex: info.StyleRelIndex ?? 0,
          StyleClassName: info.StyleClassName || '',
          CommunicationContentVersionConfigUuid: 'DUMMY',
          ConfigId: String(configId),
        },
      },
    }));
}

function sourceStyleClasses(sourceVersionMaster) {
  const info = sourceVersionMaster?.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigInfo || {};
  const data = collectionItems(info.CommunicationContentVersionConfigData)[0] || {};
  return Array.isArray(data.StyleClassName) ? data.StyleClassName : [];
}

function unwrapContentRecord(item) {
  return item?.CommunicationContentConfigRec || item || {};
}

function contentConfigId(record) {
  return String(
    record?.ConfigId
    || record?.CommunicationContentConfigInfo?.ConfigId
    || '',
  ).trim();
}

function contentBrowserItem(item) {
  const record = unwrapContentRecord(item);
  const info = record.CommunicationContentConfigInfo || {};
  return {
    shortName: String(info.ShortName || ''),
    name: String(info.Name || ''),
    description: String(info.Desc || ''),
    contentType: String(info.ContentType || ''),
    uuid: String(record.CommunicationContentConfigUuid || ''),
    configId: contentConfigId(record),
  };
}

/** Match every whitespace-separated filter term against the authored metadata. */
export function filterContentBrowserItems(items, filter = '') {
  const terms = String(filter || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const normalized = items.map(contentBrowserItem).filter((item) => item.shortName && item.uuid);
  if (!terms.length) return normalized.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return normalized
    .filter((item) => {
      const searchable = [item.shortName, item.name, item.description, item.contentType].join(' ').toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .sort((a, b) => {
      const left = `${a.shortName} ${a.name}`.toLocaleLowerCase();
      const right = `${b.shortName} ${b.name}`.toLocaleLowerCase();
      const score = (value) => terms.reduce((total, term) => total + (value.startsWith(term) ? 3 : value.includes(term) ? 1 : 0), 0);
      return score(right) - score(left) || a.shortName.localeCompare(b.shortName);
    });
}

async function resolveContent(session, input, opts) {
  const requested = requireValue(input, 'Content short name');
  if (/^[a-f\d]{32}$/i.test(requested)) {
    return { input: requested, resolved: requested, shortName: '' };
  }
  const content = await findArtifactByShortName(
    session,
    `${CONTENT_API}/CommunicationContentConfigRec`,
    'CommunicationContentConfigInfo.ShortName',
    requested,
    contentSummary,
    opts
  );
  const record = unwrapContentRecord(content);
  const uuid = record.CommunicationContentConfigUuid;
  if (!uuid) throw new Error(`Content ${requested} did not include a UUID.`);
  return {
    input: requested,
    resolved: uuid,
    shortName: record.CommunicationContentConfigInfo?.ShortName || requested,
  };
}

export async function contentListCommand(cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const configInput = String(opts.configId || '').trim();
    const config = configInput ? await resolveOpenConfigId(session, configInput, opts) : null;
    const limit = Math.min(Math.max(Number.parseInt(opts.limit || '50', 10) || 50, 1), 100);
    const filter = String(opts.filter || '').trim();
    const contentType = String(opts.type || '').trim();
    const searchFields = filter
      ? [
        'CommunicationContentConfigInfo.ShortName',
        'CommunicationContentConfigInfo.Name',
        'CommunicationContentConfigInfo.Desc',
      ]
      : [null];
    const pages = await Promise.all(searchFields.map((field) => {
      const clauses = [];
      if (config) clauses.push({ t: ['ConfigId', 'eq', String(config.resolved)] });
      if (contentType) clauses.push({ t: ['CommunicationContentConfigInfo.ContentType', 'eq', contentType] });
      if (field) clauses.push({ t: [field, 'lk', `%${filter}%`] });
      return get(
        session,
        `${CONTENT_API}/CommunicationContentConfigRec`,
        {
          depth: true,
          totalResults: true,
          offset: 0,
          limit,
          ...(clauses.length ? { whr: JSON.stringify({ a: clauses }) } : {}),
        },
        opts.verbose,
        { timeout: opts.timeout },
      );
    }));
    const recordsByUuid = new Map();
    for (const page of pages) {
      for (const item of collectionItems(page)) {
        const uuid = contentBrowserItem(item).uuid;
        if (uuid) recordsByUuid.set(uuid, item);
      }
    }
    const records = [...recordsByUuid.values()];
    // OCCS commonly returns ConfigId on the record. Older tenants omit it from
    // this read endpoint; in that case retain the record rather than hiding a
    // legitimately accessible item from the browser.
    const scoped = records.filter((item) => {
      const id = contentConfigId(unwrapContentRecord(item));
      return !config || !id || id === String(config.resolved);
    });
    const contents = filterContentBrowserItems(scoped, filter)
      .filter((item) => !contentType || item.contentType.toLowerCase() === contentType.toLowerCase())
      .slice(0, limit);
    const truncated = pages.some((page) => page?.HasMore || Number(page?.TotalResults || 0) > collectionItems(page).length) || records.length > contents.length;
    writeResult(opts, {
      ok: true,
      operation: 'list-content',
      ...(config ? { configId: config } : {}),
      filter,
      ...(contentType ? { type: contentType } : {}),
      contents,
      limit,
      truncated,
    }, [
      `${truncated ? `Showing up to ${limit}` : `Found ${contents.length}`} content item${contents.length === 1 ? '' : 's'}.`,
      ...(config ? [`ConfigId: ${configLabel(config)} (${config.resolved})`] : ['Scope: all accessible contents']),
    ]);
  });
}

export async function contentReadCommand(contentNameOrUuid, version, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const content = await resolveContent(session, contentNameOrUuid, opts);
    const contentMaster = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${content.resolved}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const versionRecord = resolveSourceContentVersion(contentMaster, version);
    const targetVersionUuid = versionRecord.CommunicationContentVersionConfigUuid;
    if (!targetVersionUuid) throw new Error(`Content version ${version} did not include a UUID.`);
    const versionMaster = await get(session, `${CONTENT_API}/CommunicationContentVersionMasterConfig/${targetVersionUuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const info = versionMaster?.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigInfo || {};
    const styles = contentVersionStyles(versionMaster);
    const data = collectionItems(info.CommunicationContentVersionConfigData)[0] || {};
    const location = data?.ContentData?.Location;
    if (!location) throw new Error(`Content version ${version} has no HTML data.`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-content-read-'));
    const htmlPath = path.join(tempDir, 'content.html');
    try {
      if (!await downloadBlob(session, location, htmlPath, opts.verbose)) throw new Error(`Could not download HTML for content version ${version}.`);
      const html = fs.readFileSync(htmlPath, 'utf8');
      const contentRecord = unwrapContentRecord(contentMaster.CommunicationContentConfigRec || contentMaster);
      writeResult(opts, {
        ok: true,
        operation: 'read-content',
        content: contentBrowserItem(contentRecord),
        version: {
          shortName: String(info.ShortName || version),
          uuid: targetVersionUuid,
          description: String(info.Desc || ''),
          language: String(info.Language || ''),
          effectiveDate: collectionItems(versionMaster?.CommunicationContentVersionConfigRec?.Status)
            .find((entry) => String(entry?.StatusCode || '').toLowerCase() === 'active')?.EffDtTm || '',
        },
        styles,
        html,
      }, [
        `Read content ${content.shortName || content.resolved} version ${info.ShortName || version}.`,
        `HTML: ${Buffer.byteLength(html)} bytes.`,
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

export async function contentStylesCommand(contentNameOrUuid, version, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const content = await resolveContent(session, contentNameOrUuid, opts);
    const contentMaster = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${content.resolved}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const versionRecord = resolveSourceContentVersion(contentMaster, version);
    const versionUuid = versionRecord.CommunicationContentVersionConfigUuid;
    if (!versionUuid) throw new Error(`Content version ${version} did not include a UUID.`);
    const versionMaster = await get(session, `${CONTENT_API}/CommunicationContentVersionMasterConfig/${versionUuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const styles = await resolveContentVersionStyles(session, versionMaster, opts);
    writeResult(opts, { ok: true, operation: 'list-content-styles', contentUuid: content.resolved, versionUuid, styles }, [
      `Found ${styles.length} style${styles.length === 1 ? '' : 's'} for content ${content.shortName || content.resolved} version ${version}.`,
    ]);
  });
}

export async function contentInspectCommand(contentNameOrUuid, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const content = await resolveContent(session, contentNameOrUuid, opts);
    const contentMaster = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${content.resolved}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const contentRecord = unwrapContentRecord(contentMaster.CommunicationContentConfigRec || contentMaster);
    const versions = collectionItems(contentMaster.CommunicationContentMasterVersions)
      .map((entry) => entry?.CommunicationContentVersionConfigRec || entry || {})
      .map((record) => {
        const info = record.CommunicationContentVersionConfigInfo || {};
        const active = collectionItems(record.Status).find((entry) => String(entry?.StatusCode || '').toLowerCase() === 'active');
        return {
          shortName: String(info.ShortName || ''),
          uuid: String(record.CommunicationContentVersionConfigUuid || ''),
          description: String(info.Desc || ''),
          language: String(info.Language || ''),
          effectiveDate: String(active?.EffDtTm || ''),
        };
      })
      .filter((item) => item.shortName && item.uuid)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.shortName.localeCompare(a.shortName));
    let selectedVersion;
    let html;
    let styles;
    if (opts.includeHtml && versions[0]) {
      selectedVersion = versions[0];
      const versionMaster = await get(session, `${CONTENT_API}/CommunicationContentVersionMasterConfig/${selectedVersion.uuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
      const info = versionMaster?.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigInfo || {};
      styles = await resolveContentVersionStyles(session, versionMaster, opts);
      const data = collectionItems(info.CommunicationContentVersionConfigData)[0] || {};
      const location = data?.ContentData?.Location;
      if (!location) throw new Error(`Content version ${selectedVersion.shortName} has no HTML data.`);
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'occs-content-inspect-'));
      const htmlPath = path.join(tempDir, 'content.html');
      try {
        if (!await downloadBlob(session, location, htmlPath, opts.verbose)) throw new Error(`Could not download HTML for content version ${selectedVersion.shortName}.`);
        html = fs.readFileSync(htmlPath, 'utf8');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
    writeResult(opts, { ok: true, operation: 'inspect-content', content: contentBrowserItem(contentRecord), versions, ...(selectedVersion ? { selectedVersion, html, styles } : {}) }, [
      `Found ${versions.length} version${versions.length === 1 ? '' : 's'} for ${content.shortName || content.resolved}.`,
    ]);
  });
}

function contentVersionStyles(versionMaster) {
  return collectionItems(versionMaster?.CommunicationContentVersionStyles)
    .map((entry) => entry?.CommunicationStyleConfigCommunicationContentVersionConfigRelRec || entry?.CommunicationContentVersionStyleRec || entry || {})
    .map((record) => {
      const info = record.CommunicationStyleConfigCommunicationContentVersionConfigRelInfo || record.CommunicationContentVersionStyleInfo || record;
      const styleInfo = record.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
      return {
        uuid: String(record.CommunicationStyleConfigCommunicationContentVersionConfigRelUuid || record.CommunicationContentVersionStyleUuid || ''),
        styleUuid: String(info.CommunicationStyleConfigUuid || ''),
        shortName: String(styleInfo.ShortName || ''),
        name: String(styleInfo.Name || ''),
        classNames: collectionItems(info.StyleClassName).map((item) => String(item)).filter(Boolean),
        index: info.StyleRelIndex ?? '',
      };
    })
    .filter((style) => style.styleUuid || style.classNames.length);
}

async function resolveContentVersionStyles(session, versionMaster, opts) {
  const styles = contentVersionStyles(versionMaster);
  return Promise.all(styles.map(async (style) => {
    if (style.shortName || !style.styleUuid) return style;
    try {
      const response = await get(
        session,
        `${STYLE_API}/CommunicationStyleConfigRec/${style.styleUuid}`,
        { depth: true },
        opts.verbose,
        { timeout: opts.timeout, throwOnError: true },
      );
      const record = response?.CommunicationStyleConfigRec || response || {};
      const info = record.CommunicationStyleConfigInfo || {};
      return {
        ...style,
        shortName: String(info.ShortName || ''),
        name: String(info.Name || ''),
      };
    } catch {
      // Style display metadata is helpful but must not prevent opening the
      // editable Content when an associated Style is unavailable.
      return style;
    }
  }));
}

export async function contentSaveCommand(contentNameOrUuid, version, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const configInput = requireValue(opts.configId, 'Config ID');
    const session = loadSession(sessionSelector(opts));
    const config = await resolveOpenConfigId(session, configInput, opts);
    const configId = String(config.resolved);
    const content = await resolveContent(session, contentNameOrUuid, opts);
    const contentMaster = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${content.resolved}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const contentRecord = unwrapContentRecord(contentMaster.CommunicationContentConfigRec || contentMaster);
    const selectedVersion = resolveSourceContentVersion(contentMaster, version);
    const selectedVersionUuid = selectedVersion.CommunicationContentVersionConfigUuid;
    if (!selectedVersionUuid) throw new Error(`Content version ${version} did not include a UUID.`);
    const versionMaster = await get(session, `${CONTENT_API}/CommunicationContentVersionMasterConfig/${selectedVersionUuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const existingContentInfo = contentRecord.CommunicationContentConfigInfo || {};
    const existingVersionRecord = versionMaster.CommunicationContentVersionConfigRec || {};
    const existingVersionInfo = existingVersionRecord.CommunicationContentVersionConfigInfo || {};
    const withConfig = (entry) => ({ ...entry, ConfigId: configId });
    const updatedContentRecord = {
      ...contentRecord,
      CommunicationContentConfigInfo: withConfig({
        ...existingContentInfo,
        Name: opts.name ?? existingContentInfo.Name,
        ShortName: opts.shortName ?? existingContentInfo.ShortName,
        Desc: opts.desc ?? existingContentInfo.Desc ?? '',
      }),
      Status: collectionItems(contentRecord.Status).map(withConfig),
    };
    const contentUpdate = {
      CommunicationContentConfigRec: updatedContentRecord,
      CommunicationContentMasterVersions: collectionItems(contentMaster.CommunicationContentMasterVersions).map((entry) => {
        const record = entry?.CommunicationContentVersionConfigRec || entry || {};
        const info = record.CommunicationContentVersionConfigInfo || {};
        return {
          CommunicationContentVersionConfigInfo: withConfig({ ...info, CommunicationContentVersionConfigData: collectionItems(info.CommunicationContentVersionConfigData).map(withConfig) }),
          CommunicationContentVersionConfigUuid: record.CommunicationContentVersionConfigUuid,
        };
      }),
    };
    await mutateJson(session, 'PUT', `${CONTENT_API}/CommunicationContentMasterConfig/${content.resolved}`, contentUpdate, { headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout });
    const versionUpdate = {
      CommunicationContentConfigRec: updatedContentRecord,
      CommunicationContentVersionConfigRec: {
        ...existingVersionRecord,
        CommunicationContentVersionConfigInfo: withConfig({
          ...existingVersionInfo,
          ShortName: opts.newVersion ?? existingVersionInfo.ShortName,
          Desc: opts.versionDesc ?? existingVersionInfo.Desc ?? '',
          CommunicationContentVersionConfigData: collectionItems(existingVersionInfo.CommunicationContentVersionConfigData).map(withConfig),
        }),
        Status: collectionItems(existingVersionRecord.Status).map(withConfig),
      },
      CommunicationContentVersionStyles: collectionItems(versionMaster.CommunicationContentVersionStyles),
    };
    await mutateJson(session, 'PUT', `${CONTENT_API}/CommunicationContentVersionMasterConfig/${selectedVersionUuid}`, versionUpdate, { headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout });
    if (opts.html) await uploadContentBlob(session, selectedVersionUuid, readHtmlFile(opts.html), configId, opts);
    writeResult(opts, { ok: true, operation: 'save-content', configId: config, contentUuid: content.resolved, versionUuid: selectedVersionUuid }, [
      `Saved content ${opts.shortName ?? existingContentInfo.ShortName} version ${opts.newVersion ?? existingVersionInfo.ShortName}.`,
    ]);
  });
}

async function uploadContentBlob(session, targetVersionUuid, html, configId, opts) {
  const { boundary, body } = buildContentBlobMultipart(html);
  return postMultipart(
    session,
    `${CONTENT_API}/CommunicationContentVersionConfigRec/${targetVersionUuid}/CommunicationContentVersionConfigInfo/CommunicationContentVersionConfigData/1/ContentData`,
    body,
    {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        transactionconfigid: String(configId),
      },
      verbose: opts.verbose,
      timeout: opts.timeout,
    }
  );
}

export async function contentCreateCommand(shortName, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const configInput = requireValue(opts.configId, 'Config ID');
    const effectiveDate = opts.effectiveDate || todayUtcDate();
    const payload = buildCreateContentPayload({
      shortName,
      name: opts.name || shortName,
      description: opts.desc || '',
      contentType: opts.type || 'Text',
      version: opts.version || '1.0',
      effectiveDate,
    });
    const html = readHtmlFile(requireValue(opts.html, 'HTML file'));
    const session = loadSession(sessionSelector(opts));
    const config = await resolveOpenConfigId(session, configInput, opts);
    const configId = config.resolved;
    if (opts.dryRun) {
      writeResult(opts, {
        ok: true, dryRun: true, operation: 'create-content', configId: config, payload, htmlBytes: Buffer.byteLength(html),
      }, [
        `Dry run: create content ${shortName} v${payload.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.ShortName}`,
        `ConfigId: ${configLabel(config)} (${configId})`,
        `HTML: ${opts.html} (${Buffer.byteLength(html)} bytes)`,
        `Effective date: ${effectiveDate}`,
        'No OCCS changes made.',
      ]);
      return;
    }
    const created = await mutateJson(session, 'POST', `${CONTENT_API}/CommunicationContentVersionMasterConfig`, payload, {
      headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
    });
    const createdVersionUuid = versionUuid(created);
    if (!createdVersionUuid || !contentUuid(created)) throw new Error('OCCS create response did not include content and version UUIDs.');
    const blob = await uploadContentBlob(session, createdVersionUuid, html, configId, opts);
    writeResult(opts, {
      ok: true, operation: 'create-content', configId: config, contentUuid: contentUuid(created), versionUuid: createdVersionUuid, htmlBytes: Buffer.byteLength(html), blob,
    }, [
      `Created content ${shortName} v${payload.CommunicationContentVersionConfigRec.CommunicationContentVersionConfigInfo.ShortName}.`,
      `ConfigId: ${configLabel(config)} (${configId})`,
      `Content UUID: ${contentUuid(created)}`,
      `Version UUID: ${createdVersionUuid}`,
      `HTML uploaded: ${Buffer.byteLength(html)} bytes.`,
    ]);
  });
}

export async function contentVersionCommand(contentNameOrUuid, version, cmd) {
  const opts = optsWithGlobals(cmd);
  return runContentCommand(opts, async () => {
    const configInput = requireValue(opts.configId, 'Config ID');
    const effectiveDate = opts.effectiveDate || todayUtcDate();
    const html = readHtmlFile(requireValue(opts.html, 'HTML file'));
    const session = loadSession(sessionSelector(opts));
    const config = await resolveOpenConfigId(session, configInput, opts);
    const configId = config.resolved;
    const content = await resolveContent(session, contentNameOrUuid, opts);
    const contentUuidValue = content.resolved;
    const contentLabel = content.shortName || contentUuidValue;
    const sourceVersionName = requireValue(opts.fromVersion, 'Source version');
    const contentMaster = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${contentUuidValue}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const sourceVersion = resolveSourceContentVersion(contentMaster, sourceVersionName);
    const sourceVersionUuid = sourceVersion.CommunicationContentVersionConfigUuid;
    if (!sourceVersionUuid) throw new Error(`Content version ${sourceVersionName} did not include a UUID.`);
    const sourceVersionMaster = await get(session, `${CONTENT_API}/CommunicationContentVersionMasterConfig/${sourceVersionUuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const copiedVersionStyles = buildCopiedVersionStyles(sourceVersionMaster.CommunicationContentVersionStyles, configId);
    const payload = buildCreateVersionPayload({
      contentUuid: contentUuidValue,
      version,
      effectiveDate,
      configId,
      styleClasses: sourceStyleClasses(sourceVersionMaster),
      versionStyles: copiedVersionStyles,
    });
    if (opts.dryRun) {
      writeResult(opts, {
        ok: true, dryRun: true, operation: 'create-content-version', configId: config, content, contentUuid: contentUuidValue, sourceVersion: sourceVersionName, payload, htmlBytes: Buffer.byteLength(html),
      }, [
        `Dry run: create content version ${version}.`,
        `ConfigId: ${configLabel(config)} (${configId})`,
        `Content: ${contentLabel}`,
        `Source version: ${sourceVersionName} (${copiedVersionStyles.length} associated styles)`,
        `HTML: ${opts.html} (${Buffer.byteLength(html)} bytes)`,
        `Effective date: ${effectiveDate}`,
        'No OCCS changes made.',
      ]);
      return;
    }
    const created = await mutateJson(session, 'POST', `${CONTENT_API}/CommunicationContentVersionMasterConfig`, payload, {
      headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
    });
    const createdVersionUuid = versionUuid(created);
    if (!createdVersionUuid) throw new Error('OCCS create-version response did not include a version UUID.');
    const update = buildVersionMasterUpdatePayload({
      createdVersion: created,
      contentRecord: contentMaster.CommunicationContentConfigRec,
      configId,
      versionStyles: copiedVersionStyles,
    });
    await mutateJson(session, 'PUT', `${CONTENT_API}/CommunicationContentVersionMasterConfig/${createdVersionUuid}`, update, {
      headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
    });
    const blob = await uploadContentBlob(session, createdVersionUuid, html, configId, opts);
    writeResult(opts, {
      ok: true, operation: 'create-content-version', configId: config, content, contentUuid: contentUuidValue, sourceVersion: sourceVersionName, versionUuid: createdVersionUuid, htmlBytes: Buffer.byteLength(html), blob,
    }, [
      `Created content version ${version}.`,
      `ConfigId: ${configLabel(config)} (${configId})`,
      `Content: ${contentLabel}`,
      `Source version: ${sourceVersionName} (${copiedVersionStyles.length} associated styles)`,
      `Version UUID: ${createdVersionUuid}`,
      `HTML uploaded: ${Buffer.byteLength(html)} bytes.`,
    ]);
  });
}

function contentSummary(item) {
  const record = unwrapContentRecord(item);
  return {
    shortName: record.CommunicationContentConfigInfo?.ShortName,
    uuid: record.CommunicationContentConfigUuid,
  };
}

export async function listContentsCommand(cmd) {
  console.log("(>'-')> Chomping contents...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/contents';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const contents = await paginate(
    session,
    '/api/CommunicationContent/v1/CommunicationContentConfigRec',
    {
      depth: true,
      totalResults: true,
    },
    25,
    cmd.verbose
  );

  const report = createArtifactFailureReport();
  const results = await mapWithConcurrency(contents, cmd.concurrency ?? 4, async (item) => {
    const record = unwrapContentRecord(item);
    const uuid = record.CommunicationContentConfigUuid;
    const shortName = record.CommunicationContentConfigInfo?.ShortName;
    if (!uuid || !shortName) return { ok: false };
    return resumeArtifact(cmd.exportResume, 'contents', uuid, item, path.join(outputDir, safePathSegment(shortName)), async () => {
      return downloadContent(session, item, outputDir, cmd.verbose, false, report);
    });
  });

  console.log(`✅ Saved ${contents.length} contents to ${outputDir}`);
  report.print();
  return { ok: report.count === 0 && results.every((result) => result?.ok), skipped: results.filter((result) => result?.skipped).length };
}

async function downloadContent(session, item, outputDir, verbose, onlyActiveVersions = false, report) {
    const record = unwrapContentRecord(item);
    const info = record.CommunicationContentConfigInfo;
    const uuid = record.CommunicationContentConfigUuid;
    const shortName = info?.ShortName;
    if (!uuid || !shortName) return false;

    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), item);

    const master = await getArtifact(
      session,
      `/api/CommunicationContent/v1/CommunicationContentMasterConfig/${uuid}`,
      {},
      verbose,
      report
    );
    if (!master) return false;
    writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

    const versions = master.CommunicationContentMasterVersions || [];

    let complete = true;
    for (const v of (onlyActiveVersions ? activeVersions(versions, 'CommunicationContentVersionConfigRec') : versions)) {
      const versionRec = v.CommunicationContentVersionConfigRec;
      const versionInfo = versionRec?.CommunicationContentVersionConfigInfo;
      const versionShortName = versionInfo?.ShortName || versionRec?.CommunicationContentVersionConfigUuid;
      const safeVersionShortName = safePathSegment(versionShortName);
      const versionFolder = path.join(folder, 'versions', safeVersionShortName);
      ensureDir(versionFolder);
      writeJSON(path.join(versionFolder, `${safeVersionShortName}.json`), versionRec);

      // The version record exposes StyleClassName but not the corresponding
      // configured style association. Retain the expanded version resource so
      // cache consumers can resolve class -> style (for example
      // subheader_border2 -> table ec subheader).
      const versionUuid = versionRec?.CommunicationContentVersionConfigUuid;
      if (versionUuid) {
        const expanded = await getArtifact(
          session,
          `/api/CommunicationContent/v1/CommunicationContentVersionMasterConfig/${versionUuid}`,
          { depth: true },
          verbose,
          report
        );
        if (expanded) writeJSON(path.join(versionFolder, `${safeVersionShortName}_expanded.json`), expanded);
        else complete = false;
      }

      const dataItems = versionInfo?.CommunicationContentVersionConfigData?.Items || [];

      for (const d of dataItems) {
        const location = 'CommunicationContent/v1/' + d.ContentData?.Location;
        const fileId = d.ContentData?.FileId;
        if (!location || !fileId) continue;

        if (!await downloadBlob(session, location, path.join(versionFolder, `${fileId}.blob`), verbose)) complete = false;
      }
    }
  return complete;
}

export async function getContentCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/contents';
  setDir(outputDir);
  const content = await findArtifactByShortName(session, '/api/CommunicationContent/v1/CommunicationContentConfigRec', 'CommunicationContentConfigInfo.ShortName', shortName, contentSummary, cmd);
  const report = createArtifactFailureReport();
  await downloadContent(session, content, outputDir, cmd.verbose, true, report);
  console.log(`✅ Saved content ${shortName} to ${outputDir}`);
  report.print();
}
