import path from 'path';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import { findArtifactByShortName } from './artifactLookup.js';
import { resumeArtifact } from './exportResume.js';

function styleSummary(item) {
  const rec = item.CommunicationStyleConfigRec || {};
  return { shortName: rec.CommunicationStyleConfigInfo?.ShortName, uuid: rec.CommunicationStyleConfigUuid };
}

export async function listStylesCommand(cmd) {
  console.log("(>'-')> Slurping styles...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/styles';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

  const styles = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationStyleConfigRec',     
    { depth: true, summary: true, totalResults: true },
    25,
    cmd.verbose
  );

  let skipped = 0;
  for (const item of styles) {
    const rec = item.CommunicationStyleConfigRec || {};
    const uuid = rec.CommunicationStyleConfigUuid;
    const shortName = rec.CommunicationStyleConfigInfo?.ShortName;
    if (!uuid || !shortName) continue;
    const result = await resumeArtifact(cmd.exportResume, 'styles', uuid, item, path.join(outputDir, safePathSegment(shortName)), async () => downloadStyle(item, outputDir));
    if (result.skipped) skipped += 1;
  }

  console.log(`✅ Saved ${styles.length} styles to ${outputDir}`);
  return { ok: true, skipped };
}

function downloadStyle(item, outputDir) {
  const shortName = item.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo?.ShortName;
  if (!shortName) return false;
  const safeShortName = safePathSegment(shortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  writeJSON(path.join(folder, `${safeShortName}.json`), item);
  return true;
}

export async function getStyleCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/styles';
  setDir(outputDir);
  const style = await findArtifactByShortName(session, '/api/CommunicationDocument/v1/CommunicationStyleConfigRec', 'CommunicationStyleConfigInfo.ShortName', shortName, styleSummary, cmd);
  downloadStyle(style, outputDir);
  console.log(`✅ Saved style ${shortName} to ${outputDir}`);
}
