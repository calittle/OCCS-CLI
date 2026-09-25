import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, stringifyJSON, writeStdoutJSON, mapWithConcurrency } from './utils.js';
import path from 'path';
import fs from 'fs';
import { resolveRequestTimeoutMs } from './requestTimeout.js';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';

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

function writeJson(payload) {
  writeStdoutJSON(payload);
}

function documentSearchWhere(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return undefined;
  return JSON.stringify({
    a: [
      {
        t: ['CommunicationDocumentConfigInfo.ShortName', 'lk', `%${trimmed}%`],
      },
    ],
  });
}

export function documentSummary(item) {
  const rec = item?.CommunicationDocumentConfigRec || item || {};
  const info = rec.CommunicationDocumentConfigInfo || {};
  const config = item?.ConfigurationRec || {};
  const configInfo = config.ConfigurationInfo || {};
  return {
    uuid: rec.CommunicationDocumentConfigUuid || '',
    name: info.Name || '',
    shortName: info.ShortName || '',
    description: info.Desc || '',
    configId: rec.ConfigId || info.ConfigId || '',
    configuration: config.ConfigurationId ? {
      id: config.ConfigurationId,
      uuid: config.ConfigurationUuid || '',
      shortName: configInfo.ShortName || '',
      name: configInfo.Name || '',
    } : null,
  };
}

export async function searchDocuments(session, query = '', opts = {}) {
  const params = {
    depth: true,
    summary: true,
    totalResults: true,
  };
  const whr = documentSearchWhere(query);
  if (whr) {
    params.whr = whr;
  }

  const documents = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationDocumentConfigRec',
    params,
    Number(opts.limit || 49),
    opts.verbose,
    { timeout: resolveRequestTimeoutMs(opts.timeout) }
  );

  return documents.map(documentSummary).filter((document) => document.uuid);
}

export async function getDocumentMasterSummary(session, documentUuid, opts = {}) {
  const master = await get(
    session,
    `/api/CommunicationDocument/v1/CommunicationDocumentMasterConfig/${documentUuid}`,
    { depth: true, limit: Number(opts.limit || 40) },
    opts.verbose,
    { timeout: resolveRequestTimeoutMs(opts.timeout), throwOnError: Boolean(opts.throwOnError) }
  );
  return documentSummary(master.CommunicationDocumentConfigRec || {});
}

export async function documentCatalogCommand(cmd) {
  const opts = optsWithGlobals(cmd);
  const session = loadSession(sessionSelector(opts));
  const query = opts.name || opts.query || '';
  const documents = await searchDocuments(session, query, opts);
  const response = {
    ok: true,
    query,
    count: documents.length,
    documents,
  };

  if (opts.output) {
    const outputPath = path.resolve(opts.output);
    ensureDir(path.dirname(outputPath));
    fs.writeFileSync(outputPath, stringifyJSON(response));
  }

  if (opts.json || opts.output) {
    writeJson(response);
    return;
  }

  for (const document of documents) {
    console.log(`${document.shortName}\t${document.uuid}\t${document.description}`);
  }
}

export async function listDocumentsCommand(cmd) {
  console.log("(>'-')> Dumping documents...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/documents';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const documents = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationDocumentConfigRec',
    {
      depth: true,
      summary: true,
    },
    50,
    cmd.verbose
  );

  const report = createArtifactFailureReport();
  const results = await mapWithConcurrency(documents, cmd.concurrency ?? 4, async (doc) => {
    const rec = doc.CommunicationDocumentConfigRec || {};
    const uuid = rec.CommunicationDocumentConfigUuid;
    const shortName = rec.CommunicationDocumentConfigInfo?.ShortName;
    // Ignore CCS index rows that cannot identify a document to download.
    if (!uuid || !shortName) return { ok: true, skipped: true };
    return resumeArtifact(cmd.exportResume, 'documents', uuid, doc, path.join(outputDir, safePathSegment(shortName)), async () => {
      return downloadDocument(session, doc, outputDir, cmd.verbose, false, report);
    });
  });

  console.log(`✅ Saved ${documents.length} documents to ${outputDir}`);
  report.print();
  return { ok: report.count === 0 && results.every((result) => result?.ok), skipped: results.filter((result) => result?.skipped).length };
}

async function downloadDocument(session, doc, outputDir, verbose, onlyActiveVersions = false, report) {
  const config = doc.CommunicationDocumentConfigRec;
  const info = config?.CommunicationDocumentConfigInfo;
  const docUuid = config?.CommunicationDocumentConfigUuid;
  if (!info?.ShortName || !docUuid) return false;
  const safeShortName = safePathSegment(info.ShortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  writeJSON(path.join(folder, 'document.json'), doc);
  const master = await getArtifact(session, `/api/CommunicationDocument/v1/CommunicationDocumentMasterConfig/${docUuid}`, { depth: true }, verbose, report);
  if (!master) return false;
  writeJSON(path.join(folder, `${safeShortName}_master.json`), master);
  const versions = master.CommunicationDocumentMasterVersions || [];
  let complete = true;
  for (const v of (onlyActiveVersions ? activeVersions(versions, 'CommunicationDocumentVersionConfigRec') : versions)) {
    const versionRec = v.CommunicationDocumentVersionConfigRec;
    const versionUuid = versionRec?.CommunicationDocumentVersionConfigUuid;
    const versionShortName = versionRec?.CommunicationDocumentVersionConfigInfo?.ShortName || versionUuid;
    if (!versionUuid) continue;
    const versionDetails = await getArtifact(session, `/api/CommunicationDocument/v1/CommunicationDocumentVersionMasterConfig/${versionUuid}`, { depth: true }, verbose, report);
    if (!versionDetails) { complete = false; continue; }
    const versionDir = path.join(folder, 'versions');
    ensureDir(versionDir);
    writeJSON(path.join(versionDir, `${safePathSegment(versionShortName)}.json`), versionDetails);
  }
  return complete;
}

export async function getDocumentCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/documents';
  setDir(outputDir);
  const doc = await findArtifactByShortName(session, '/api/CommunicationDocument/v1/CommunicationDocumentConfigRec', 'CommunicationDocumentConfigInfo.ShortName', shortName, documentSummary, cmd);
  const report = createArtifactFailureReport();
  await downloadDocument(session, doc, outputDir, cmd.verbose, true, report);
  console.log(`✅ Saved document ${shortName} to ${outputDir}`);
  report.print();
}
