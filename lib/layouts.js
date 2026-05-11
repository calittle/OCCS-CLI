// lib/layouts.js
import { loadSession } from './session.js';
import { get, paginate } from './api.js';
import { setDir, ensureDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

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

  for (const masterLayout of masterLayouts) {
    
    const uuid = masterLayout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigUuid;
    if (!uuid) continue;    
    const layout = await get(session,`/api/CommunicationDocument/v1/CommunicationLayoutMasterConfig/${uuid}`,{depth:true},cmd.verbose);
    const shortName = layout.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo?.ShortName;

    const safeShortName = safePathSegment(shortName);
    const folder = path.join(outputDir, safeShortName);
    ensureDir(folder);
    writeJSON(path.join(folder, `${safeShortName}.json`), layout);
  }

  console.log(`✅ Saved ${masterLayouts.length} layouts to ${outputDir}`);
}
