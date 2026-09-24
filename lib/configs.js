import { loadSession } from './session.js';
import { paginate } from './api.js';
import { ensureDir, setDir, writeJSON, safePathSegment, writeStdoutJSON } from './utils.js';
import path from 'path';

function writeJson(payload) {
  writeStdoutJSON(payload);
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

function sessionSelector(opts = {}) {
  return {
    sessionName: opts.session,
    customer: opts.customer,
    region: opts.region ?? opts.environment,
    tenancy: opts.tenancy,
  };
}

function configResolutionError(message, details = undefined) {
  const error = new Error(message);
  error.details = details;
  return error;
}

/** Match one open ConfigId from the ID users see in the Comms UI. */
export function selectOpenConfigId(items, input) {
  const wanted = String(input || '').trim();
  if (!wanted) {
    throw configResolutionError('Missing required --config-id value.');
  }
  const matches = (items || [])
    .map(configSummary)
    .filter((config) => config.id === wanted
      || config.shortName.toLowerCase() === wanted.toLowerCase()
      || config.name.toLowerCase() === wanted.toLowerCase());

  if (matches.length === 0) {
    throw configResolutionError(`Open ConfigId not found: ${wanted}`);
  }
  if (matches.length > 1) {
    throw configResolutionError(`ConfigId is ambiguous: ${wanted}`, {
      matches: matches.map(({ id, shortName, name }) => ({ id, shortName, name })),
    });
  }
  return { input: wanted, resolved: matches[0].id, ...matches[0] };
}

/** Resolve an open ConfigId from the ID users see in the Comms UI. */
export async function resolveOpenConfigId(session, input, opts = {}) {
  const configs = await paginate(
    session,
    '/api/ConfigurationId/v1/ConfigurationRec',
    {
      depth: true,
      totalResults: true,
      whr: JSON.stringify({
        t: ['ConfigurationStatus.ConfigurationStatusCode', 'eq', 'Open'],
      }),
    },
    100,
    opts.verbose,
    { timeout: opts.timeout, throwOnError: true }
  );
  return selectOpenConfigId(configs, input);
}

export async function listConfigsCommand(cmd) {
  if (!cmd.json) {
    console.log("(>'-')> Catching configIDs...\n");
  }
  const session = loadSession(sessionSelector(cmd));
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
