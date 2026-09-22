import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import { downloadBlob } from './download.js';
import path from 'path';
import { activeVersions, findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';

function contentSummary(item) {
  return { shortName: item.CommunicationContentConfigInfo?.ShortName, uuid: item.CommunicationContentConfigUuid };
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
    const uuid = item.CommunicationContentConfigUuid;
    const shortName = item.CommunicationContentConfigInfo?.ShortName;
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
    const info = item.CommunicationContentConfigInfo;
    const uuid = item.CommunicationContentConfigUuid;
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
