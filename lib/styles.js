import path from 'path';
import { loadSession } from './session.js';
import { paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';

export async function listStylesCommand(cmd) {
  console.log("(>'-')> Slurping styles...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/styles';
  setDir(outputDir);

  const styles = await paginate(
    session,
    '/api/CommunicationDocument/v1/CommunicationStyleConfigRec',     
    { depth: true, summary: true, totalResults: true },
    25,
    cmd.verbose
  );

  for (const item of styles) {
    const info = item.CommunicationStyleConfigRec.CommunicationStyleConfigInfo;
    const shortName = info?.ShortName || 'unnamed';
    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), item);
  }

  console.log(`✅ Saved ${styles.length} styles to ${outputDir}`);
}
