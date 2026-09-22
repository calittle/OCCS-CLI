import path from 'path';
import fs from 'fs';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment, mapWithConcurrency } from './utils.js';
import { downloadFont } from './download.js';
import { findArtifactByShortName } from './artifactLookup.js';
import { resumeArtifact } from './exportResume.js';

function fontSummary(item) {
  return { shortName: item.CommunicationFontConfigInfo?.ShortName, uuid: item.CommunicationFontConfigUuid };
}

export async function listFontsCommand(cmd) {
  console.log("(>'-')> Finding fonts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/fonts';
  if (cmd.exportResume) ensureDir(outputDir); else setDir(outputDir);

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
