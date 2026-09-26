import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { loadSession } from './session.js';
import { get, mutateJson, paginate, postMultipart } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import { downloadFont } from './download.js';
import { findArtifactByShortName } from './artifactLookup.js';
import { resumeArtifact } from './exportResume.js';
import { resolveOpenConfigId } from './configs.js';

const FONT_API = '/api/CommunicationDocument/v1';

function optsWithGlobals(cmd) {
  return typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : (cmd || {});
}

function sessionSelector(opts = {}) {
  return { sessionName: opts.session, customer: opts.customer, region: opts.region ?? opts.environment, tenancy: opts.tenancy };
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function occsDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) throw new Error('Effective date must be YYYY-MM-DD.');
  return `${value}T00:00:00.000000Z`;
}

/** Build the intentionally minimal pre-upload Font record observed in Comms. */
export function buildCreateFontPayload({ shortName, name = shortName, description = 'none' }) {
  if (!String(shortName || '').trim()) throw new Error('Font short name is required.');
  return {
    CommunicationFontConfigInfo: {
      Name: String(name || shortName), ShortName: String(shortName), Desc: String(description),
      FontFamily: 'none', FontScalable: false, FontSize: 0, FontStyle: 'none',
    },
  };
}

export function buildFileMultipart(filePath) {
  const file = fs.readFileSync(filePath);
  const boundary = `----occs-cli-${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name=""; filename="${path.basename(filePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, body: Buffer.concat([head, file, tail]) };
}

function fontSummary(item) {
  return { shortName: item.CommunicationFontConfigInfo?.ShortName, uuid: item.CommunicationFontConfigUuid };
}

export async function listFontsCommand(cmd) {
  console.log("(>'-')> Finding fonts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/fonts';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const fonts = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationFontConfigRec',
    { depth: true },
    25,
    cmd.verbose
  );

  const failedFonts = [];
  let downloadedFonts = 0;
  let existingFonts = 0;

  const fontResults = await mapWithConcurrency(fonts, cmd.concurrency ?? 4, async (item) => {
    const uuid = item.CommunicationFontConfigUuid;
    const shortName = item.CommunicationFontConfigInfo?.ShortName;
    if (!uuid || !shortName) return { downloaded: 0, existing: 0, failed: { shortName: shortName || 'unknown', location: 'missing font identifier' } };
    const result = await resumeArtifact(cmd.exportResume, 'fonts', uuid, item, path.join(outputDir, safePathSegment(shortName)), async () => {
      const font = await downloadOneFont(session, item, outputDir, cmd.verbose);
      return font.failed ? false : font;
    });
    if (!result.ok) return { downloaded: 0, existing: 0, failed: { shortName, location: 'font download failed' } };
    if (result.skipped) return { downloaded: 0, existing: 1 };
    return result.ok;
  });
  for (const result of fontResults) {
    if (result.failed) failedFonts.push(result.failed);
    downloadedFonts += result.downloaded;
    existingFonts += result.existing;
  }

  console.log(`✅ Saved ${fonts.length} fonts to ${outputDir}`);
  if (existingFonts || downloadedFonts) {
    console.log(`   Font files: ${downloadedFonts} downloaded, ${existingFonts} already present`);
  }
  if (failedFonts.length) {
    console.error(`⚠ ${failedFonts.length} font file${failedFonts.length === 1 ? '' : 's'} could not be downloaded; metadata was saved and a later \`list-fonts\` run will retry only the missing file${failedFonts.length === 1 ? '' : 's'}.`);
    console.error(`⚠ Artifact download failures (${failedFonts.length}):`);
    console.error(`  request (${failedFonts.length})`);
    for (const failure of failedFonts) console.error(`    - ${failure.location}`);
    process.exitCode = 1;
    return { ok: false, failedFonts };
  }

  return { ok: true, failedFonts: [] };
}

async function downloadOneFont(session, item, outputDir, verbose) {
  let downloaded = 0;
  let existing = 0;
  const info = item.CommunicationFontConfigInfo;
  const shortName = info?.ShortName || 'unnamed';
  const safeShortName = safePathSegment(shortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  writeJSON(path.join(folder, `${safeShortName}.json`), item);
  const location = info.FontImportedContent?.Location;
  const fileName = info.FontImportedContent?.FileName;
  if (location && fileName) {
    const fontPath = path.join(folder, safePathSegment(fileName));
    if (fs.existsSync(fontPath) && fs.statSync(fontPath).size > 0) {
      existing = 1;
    } else if (await downloadFont(session, location, fontPath, verbose)) {
      downloaded = 1;
    } else {
      return { downloaded, existing, failed: { shortName, location } };
    }
  }
  return { downloaded, existing };
}

export async function getFontCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/fonts';
  setDir(outputDir);
  const font = await findArtifactByShortName(session, '/api/CommunicationDocument/v1/CommunicationFontConfigRec', 'CommunicationFontConfigInfo.ShortName', shortName, fontSummary, cmd);
  const result = await downloadOneFont(session, font, outputDir, cmd.verbose);
  if (result.failed) {
    process.exitCode = 1;
    throw new Error(`Font file could not be downloaded: ${shortName}`);
  }
  console.log(`✅ Saved font ${shortName} to ${outputDir}`);
}

/**
 * Create a Font shell, upload its binary, then save the metadata Comms derives
 * from that binary.  Comms rejects duplicate font binaries with its own 400;
 * surface that response rather than attempting to invent a client-side hash.
 */
export async function fontCreateCommand(shortName, cmd) {
  const opts = optsWithGlobals(cmd);
  const filePath = String(opts.file || '').trim();
  if (!filePath) throw new Error('--file is required.');
  if (!fs.existsSync(filePath)) throw new Error(`Font file not found: ${filePath}`);
  const session = loadSession(sessionSelector(opts));
  const config = await resolveOpenConfigId(session, opts.configId, opts);
  const configId = String(config.resolved);
  const payload = buildCreateFontPayload({ shortName, name: opts.name || shortName, description: opts.desc ?? 'none' });
  if (opts.dryRun) {
    console.log(`Dry run: create font ${shortName} from ${filePath}.`);
    return { ok: true, dryRun: true, payload, configId: config };
  }
  const created = await mutateJson(session, 'POST', `${FONT_API}/CommunicationFontConfigRec`, payload, {
    headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout,
  });
  const uuid = created?.CommunicationFontConfigUuid || created?.CommunicationFontConfigRec?.CommunicationFontConfigUuid;
  if (!uuid) throw new Error('OCCS create response did not include a font UUID.');
  const { boundary, body } = buildFileMultipart(filePath);
  await postMultipart(session, `${FONT_API}/CommunicationFontConfigRec/${uuid}/CommunicationFontConfigInfo/FontImportedContent`, body, {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length), transactionconfigid: configId },
    verbose: opts.verbose, timeout: opts.timeout,
  });
  const fetched = await get(session, `${FONT_API}/CommunicationFontConfigRec/${uuid}`, { depth: true }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  const record = fetched?.CommunicationFontConfigRec || fetched || {};
  const info = record.CommunicationFontConfigInfo;
  if (!info) throw new Error('OCCS did not return font metadata after upload.');
  const date = opts.effectiveDate || todayUtcDate();
  await mutateJson(session, 'PUT', `${FONT_API}/CommunicationFontConfigRec/${uuid}`, {
    CommunicationFontConfigInfo: { ...info, ConfigId: configId },
    Status: [
      { StatusCode: 'In Progress', EffDtTm: occsDate(date), ConfigId: configId },
      { StatusCode: 'Active', EffDtTm: occsDate(date), ConfigId: configId },
    ],
    CommunicationFontConfigUuid: uuid,
    ConfigId: configId,
  }, { headers: { transactionconfigid: configId }, verbose: opts.verbose, timeout: opts.timeout });
  console.log(`✅ Created font ${shortName} from ${path.basename(filePath)}.`);
  return { ok: true, configId: config, uuid, shortName };
}
