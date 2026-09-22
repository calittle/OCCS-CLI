// lib/layouts.js
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import path from 'path';
import { findArtifactByShortName } from './artifactLookup.js';
import { createArtifactFailureReport, getArtifact } from './artifactFailures.js';
import { resumeArtifact } from './exportResume.js';

function layoutSummary(item) {
  const rec = item.CommunicationLayoutConfigRec || {};
  return { shortName: rec.CommunicationLayoutConfigInfo?.ShortName, uuid: rec.CommunicationLayoutConfigUuid };
}

export async function listLayoutsCommand(cmd) {
  console.log("(>'-')> Listing layouts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/layouts';
  if (cmd.exportResume?.resumed) ensureDir(outputDir); else setDir(outputDir);

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

  const report = createArtifactFailureReport();
  const results = await mapWithConcurrency(masterLayouts, cmd.concurrency ?? 4, async (layout) => {
    const rec = layout.CommunicationLayoutConfigRec || {};
    const uuid = rec.CommunicationLayoutConfigUuid;
    const shortName = rec.CommunicationLayoutConfigInfo?.ShortName;
    if (!uuid || !shortName) return { ok: false };
    return resumeArtifact(cmd.exportResume, 'layouts', uuid, layout, path.join(outputDir, safePathSegment(shortName)), async () => {
      return downloadLayout(session, layout, outputDir, cmd.verbose, report);
    });
  });

  console.log(`✅ Saved ${masterLayouts.length} layouts to ${outputDir}`);
  report.print();
  return { ok: report.count === 0 && results.every((result) => result?.ok), skipped: results.filter((result) => result?.skipped).length };
}

async function downloadLayout(session, masterLayout, outputDir, verbose, report) {
  const uuid = masterLayout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigUuid;
  if (!uuid) return false;
  const layout = await getArtifact(session, `/api/CommunicationDocument/v1/CommunicationLayoutMasterConfig/${uuid}`, { depth: true }, verbose, report);
  if (!layout) return false;
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
  const report = createArtifactFailureReport();
  await downloadLayout(session, layout, outputDir, cmd.verbose, report);
  console.log(`✅ Saved layout ${shortName} to ${outputDir}`);
  report.print();
}
