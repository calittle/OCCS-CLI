import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, stringifyJSON, writeStdoutJSON } from './utils.js';
import path from 'path';
import fs from 'fs';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

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
  setDir(outputDir);

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

  for (const doc of documents) {
    const config = doc.CommunicationDocumentConfigRec;
    const info = config?.CommunicationDocumentConfigInfo;
    const docUuid = config?.CommunicationDocumentConfigUuid;

    if (!info?.ShortName || !docUuid) continue;

    const safeShortName = safePathSegment(info.ShortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, 'document.json'), doc);

    // Get master config
    const master = await get(
      session,
      `/api/CommunicationDocument/v1/CommunicationDocumentMasterConfig/${docUuid}`,
      { depth: true },
      cmd.verbose
    );

    writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

    const versions = master.CommunicationDocumentMasterVersions || [];

    for (const v of versions) {
      const versionRec = v.CommunicationDocumentVersionConfigRec;
      const versionUuid = versionRec?.CommunicationDocumentVersionConfigUuid;
      const versionInfo = versionRec?.CommunicationDocumentVersionConfigInfo;
      const versionShortName = versionInfo?.ShortName || versionUuid;

      if (!versionUuid) continue;

      const versionDetails = await get(
        session,
        `/api/CommunicationDocument/v1/CommunicationDocumentVersionMasterConfig/${versionUuid}`,
        { depth: true },
        cmd.verbose
      );

      const versionDir = path.join(folder, 'versions');
      ensureDir(versionDir);
      writeJSON(path.join(versionDir, `${safePathSegment(versionShortName)}.json`), versionDetails);
    }
  }

  console.log(`✅ Saved ${documents.length} documents to ${outputDir}`);
}
