import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import { downloadBlob } from './download.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';

function contentSummary(item) {
  return { shortName: item.CommunicationContentConfigInfo?.ShortName, uuid: item.CommunicationContentConfigUuid };
}

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

  for (const item of contents) await downloadContent(session, item, outputDir, cmd.verbose);

  console.log(`✅ Saved ${contents.length} contents to ${outputDir}`);
}

async function downloadContent(session, item, outputDir, verbose, onlyActiveVersions = false) {
    const info = item.CommunicationContentConfigInfo;
    const uuid = item.CommunicationContentConfigUuid;
    const shortName = info?.ShortName;
    if (!uuid || !shortName) return false;

    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), item);

    const master = await get(
      session,
      `/api/CommunicationContent/v1/CommunicationContentMasterConfig/${uuid}`,
      {},
      verbose
    );
    writeJSON(path.join(folder, `${safeShortName}_master.json`), master);

    const versions = master.CommunicationContentMasterVersions || [];

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
        const expanded = await get(
          session,
          `/api/CommunicationContent/v1/CommunicationContentVersionMasterConfig/${versionUuid}`,
          { depth: true },
          verbose
        );
        writeJSON(path.join(versionFolder, `${safeVersionShortName}_expanded.json`), expanded);
      }

      const dataItems = versionInfo?.CommunicationContentVersionConfigData?.Items || [];

      for (const d of dataItems) {
        const location = 'CommunicationContent/v1/' + d.ContentData?.Location;
        const fileId = d.ContentData?.FileId;
        if (!location || !fileId) continue;

        await downloadBlob(session, location, path.join(versionFolder, `${fileId}.blob`), verbose);
      }
    }
  return true;
}

export async function getContentCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/contents';
  setDir(outputDir);
  const content = await findArtifactByShortName(session, '/api/CommunicationContent/v1/CommunicationContentConfigRec', 'CommunicationContentConfigInfo.ShortName', shortName, contentSummary, cmd);
  await downloadContent(session, content, outputDir, cmd.verbose, true);
  console.log(`✅ Saved content ${shortName} to ${outputDir}`);
}
