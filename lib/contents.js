import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import { downloadBlob } from './download.js';
import path from 'path';

export async function listContentsCommand(cmd) {
  console.log("(>'-')> Chomping contents...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/contents';
  setDir(outputDir);

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

  for (const item of contents) {
    const info = item.CommunicationContentConfigInfo;
    const uuid = item.CommunicationContentConfigUuid;
    const shortName = info?.ShortName;
    if (!uuid || !shortName) continue;

    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), item);

    const master = await get(
      session,
      `/api/CommunicationContent/v1/CommunicationContentMasterConfig/${uuid}`,
      {},
      cmd.verbose
    );
    writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

    const versions = master.CommunicationContentMasterVersions || [];

    for (const v of versions) {
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
        const expanded = await get(
          session,
          `/api/CommunicationContent/v1/CommunicationContentVersionMasterConfig/${versionUuid}`,
          { depth: true },
          cmd.verbose
        );
        writeJSON(path.join(versionFolder, `${safeVersionShortName}_expanded.json`), expanded);
      }

      const dataItems = versionInfo?.CommunicationContentVersionConfigData?.Items || [];

      for (const d of dataItems) {
        const location = 'CommunicationContent/v1/' + d.ContentData?.Location;
        const fileId = d.ContentData?.FileId;
        if (!location || !fileId) continue;

        await downloadBlob(session, location, path.join(versionFolder, `${fileId}.blob`), cmd.verbose);
      }
    }
  }

  console.log(`✅ Saved ${contents.length} contents to ${outputDir}`);
}
