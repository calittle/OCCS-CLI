import { loadSession } from './session.js';
import { paginate } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment } from './utils.js';
import path from 'path';

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function unwrapConfigRec(item) {
  return item?.ConfigurationRec || item || {};
}

function firstStatusItem(configRec) {
  const status = configRec?.ConfigurationStatus;
  if (!status) {
    return {};
  }
  if (Array.isArray(status)) {
    return status[0] || {};
  }
  if (Array.isArray(status.Items)) {
    return status.Items[0] || {};
  }
  return status;
}

function configSummary(item) {
  const configRec = unwrapConfigRec(item);
  const info = configRec.ConfigurationInfo || {};
  const status = firstStatusItem(configRec);

  return {
    id: String(configRec.ConfigurationId || ''),
    uuid: configRec.ConfigurationUuid || '',
    shortName: info.ShortName || '',
    name: info.Name || '',
    description: info.Desc || '',
    status: status.ConfigurationStatusCode || '',
    effectiveAt: status.EffDtTm || '',
  };
}

export async function listConfigsCommand(cmd) {
  if (!cmd.json) {
    console.log("(>'-')> Catching configIDs...\n");
  }
  const session = loadSession();
  const outputDir = cmd.output || './output/configs';
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
    cmd.verbose,
    { timeout: cmd.timeout }
  );

  if (cmd.json) {
    const summaries = configs
      .map(configSummary)
      .filter((config) => config.id);
    writeJson({
      ok: true,
      count: summaries.length,
      configs: summaries,
    });
    return;
  }

  setDir(outputDir);
  for (const config of configs) {
    const summary = configSummary(config);
    const ShortName = summary.shortName || summary.name || summary.id;
    const ID = summary.id;
    const folder = path.join(outputDir, safePathSegment(ShortName));
    ensureDir(folder);
    writeJSON(path.join(folder, `${safePathSegment(ID)}.json`), config);
    
  }

  console.log(`✅ Saved ${configs.length} configs to ${outputDir}`);
}
