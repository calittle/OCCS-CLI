import { loadSession } from './session.js';
import { paginate, get } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

export async function listConfigsCommand(cmd) {
  console.log("(>'-')> Catching configIDs...\n");
  const session = loadSession();
  const outputDir = cmd.output || './output/configs';
  setDir(outputDir);
  const configs = await paginate(
    session,
    '/api/ConfigurationId/v1/ConfigurationRec',
    {
      depth: true,
      summary: true,
      totalResults: true,
      whr: "%7B%22t%22%3A%5B%22ConfigurationStatus.ConfigurationStatusCode%22%2C%22eq%22%2C%22Open%22%5D%7D"
    },
    30,
    cmd.verbose
  );

  for (const config of configs) {
    const ShortName = config.ConfigurationRec?.ConfigurationInfo?.ShortName;
    const ID = config.ConfigurationRec?.ConfigurationId;
    const folder = path.join(outputDir, safePathSegment(ShortName));
    ensureDir(folder);
    writeJSON(path.join(folder, `${safePathSegment(ID)}.json`), config);
    
  }

  console.log(`✅ Saved ${configs.length} configs to ${outputDir}`);
}
