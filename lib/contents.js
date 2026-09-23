import { loadSession } from './session.js';
import { get, mutateJson, paginate, postMultipart } from './api.js';
import crypto from 'crypto';
import fs from 'fs';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency, writeStdoutJSON } from './utils.js';
import { downloadBlob } from './download.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';
import { resolveOpenConfigId } from './configs.js';

const CONTENT_API = '/api/CommunicationContent/v1';
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
    CommunicationContentVersionStyles: [],
  };
}

export function buildVersionMasterUpdatePayload({ createdVersion, contentRecord, configId, inProgressDate = todayUtcDate() }) {
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
    CommunicationContentVersionStyles: collectionItems(createdVersion.CommunicationContentVersionStyles),
    CommunicationContentConfigRec: {
      ...contentRecord,
      CommunicationContentConfigInfo: withConfigId(contentRecord.CommunicationContentConfigInfo),
      Status: (contentRecord.Status?.Items || contentRecord.Status || []).map(withConfigId),
      ConfigId: String(configId),
    },
  };
}

export function buildContentBlobMultipart(html) {
  const boundary = `----occs-cli-${crypto.randomBytes(12).toString('hex')}`;
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name=""; filename="blob"',
    'Content-Type: application/octet-stream',
    '',
    String(html),
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

function unwrapContentRecord(item) {
  return item?.CommunicationContentConfigRec || item || {};
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
    const payload = buildCreateVersionPayload({
      contentUuid: contentUuidValue,
      version,
      effectiveDate,
      configId,
    });
    if (opts.dryRun) {
      writeResult(opts, {
        ok: true, dryRun: true, operation: 'create-content-version', configId: config, content, contentUuid: contentUuidValue, payload, htmlBytes: Buffer.byteLength(html),
      }, [
        `Dry run: create content version ${version}.`,
        `ConfigId: ${configLabel(config)} (${configId})`,
        `Content: ${contentLabel}`,
        `HTML: ${opts.html} (${Buffer.byteLength(html)} bytes)`,
        `Effective date: ${effectiveDate}`,
        'No OCCS changes made.',
      ]);
      return;
    }
    const master = await get(session, `${CONTENT_API}/CommunicationContentMasterConfig/${contentUuidValue}`, { depth: true, limit: 30 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const created = await mutateJson(session, 'POST', `${CONTENT_API}/CommunicationContentVersionMasterConfig`, payload, {
      headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
    });
    const createdVersionUuid = versionUuid(created);
    if (!createdVersionUuid) throw new Error('OCCS create-version response did not include a version UUID.');
    const update = buildVersionMasterUpdatePayload({
      createdVersion: created,
      contentRecord: master.CommunicationContentConfigRec,
      configId,
    });
    await mutateJson(session, 'PUT', `${CONTENT_API}/CommunicationContentVersionMasterConfig/${createdVersionUuid}`, update, {
      headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
    });
    const blob = await uploadContentBlob(session, createdVersionUuid, html, configId, opts);
    writeResult(opts, {
      ok: true, operation: 'create-content-version', configId: config, content, contentUuid: contentUuidValue, versionUuid: createdVersionUuid, htmlBytes: Buffer.byteLength(html), blob,
    }, [
      `Created content version ${version}.`,
      `ConfigId: ${configLabel(config)} (${configId})`,
      `Content: ${contentLabel}`,
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
