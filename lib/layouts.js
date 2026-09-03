// lib/layouts.js
import { loadSession } from './session.js';
import { get, paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';
import { findArtifactByShortName } from './artifactLookup.js';

function layoutSummary(item) {
  const rec = item.CommunicationLayoutConfigRec || {};
  return { shortName: rec.CommunicationLayoutConfigInfo?.ShortName, uuid: rec.CommunicationLayoutConfigUuid };
}

export async function listLayoutsCommand(cmd) {
  console.log("(>'-')> Listing layouts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/layouts';
  setDir(outputDir);

  const masterLayouts = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationLayoutConfigRec',
    {
      depth: true,
      summary: true,
    },
    50,
    cmd.verbose
  );

  for (const masterLayout of masterLayouts) await downloadLayout(session, masterLayout, outputDir, cmd.verbose);

  console.log(`✅ Saved ${masterLayouts.length} layouts to ${outputDir}`);
}

async function downloadLayout(session, masterLayout, outputDir, verbose) {
  const uuid = masterLayout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigUuid;
  if (!uuid) return false;
  const layout = await get(session, `/api/CommunicationDocument/v1/CommunicationLayoutMasterConfig/${uuid}`, { depth: true }, verbose);
  const shortName = layout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo?.ShortName;
  if (!shortName) return false;
  const safeShortName = safePathSegment(shortName);
  const folder = path.join(outputDir, safeShortName);
  ensureDir(folder);
  writeJSON(path.join(folder, `${safeShortName}.json`), layout);
  return true;
}

export async function getLayoutCommand(shortName, cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/layouts';
  setDir(outputDir);
  const layout = await findArtifactByShortName(session, '/api/CommunicationDocument/v1/CommunicationLayoutConfigRec', 'CommunicationLayoutConfigInfo.ShortName', shortName, layoutSummary, cmd);
  await downloadLayout(session, layout, outputDir, cmd.verbose);
  console.log(`✅ Saved layout ${shortName} to ${outputDir}`);
}
