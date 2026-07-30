import path from 'path';
import fs from 'fs';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import { downloadFont } from './download.js';

export async function listFontsCommand(cmd) {
  console.log("(>'-')> Finding fonts...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/fonts';
  setDir(outputDir);

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

  for (const item of fonts) {
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
      // A rerun only fetches the missing assets, so it is safe to use as recovery.
      if (fs.existsSync(fontPath) && fs.statSync(fontPath).size > 0) {
        existingFonts += 1;
        continue;
      }

      const downloaded = await downloadFont(session, location, fontPath, cmd.verbose);
      if (downloaded) {
        downloadedFonts += 1;
      } else {
        failedFonts.push({ shortName, location });
      }
    }
  }

  console.log(`✅ Saved ${fonts.length} fonts to ${outputDir}`);
  if (existingFonts || downloadedFonts) {
    console.log(`   Font files: ${downloadedFonts} downloaded, ${existingFonts} already present`);
  }
  if (failedFonts.length) {
    console.error(`⚠ ${failedFonts.length} font file${failedFonts.length === 1 ? '' : 's'} could not be downloaded; metadata was saved and a later \`list-fonts\` run will retry only the missing file${failedFonts.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
    return { ok: false, failedFonts };
  }

  return { ok: true, failedFonts: [] };
}
