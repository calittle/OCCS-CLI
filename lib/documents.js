import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

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
