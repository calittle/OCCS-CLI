import path from 'path';
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

  for (const item of fonts) {
    const info = item.CommunicationFontConfigInfo;
    const shortName = info?.ShortName || 'unnamed';
    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), item);
   
    const location = info.FontImportedContent?.Location;
    const fileName = info.FontImportedContent?.FileName;    
    if (location && fileName){
        await downloadFont(session, location, path.join(folder, safePathSegment(fileName)), cmd.verbose);
    }
  }

  console.log(`✅ Saved ${fonts.length} fonts to ${outputDir}`);
}
