import path from 'path';
import chalk from 'chalk';
import { get, paginate } from './api.js';
import { loadSession } from './session.js';
import { ensureDir, safePathSegment, writeJSON } from './utils.js';

const TARGET_DOMAINS = new Set([
  'CommunicationPackage',
  'CommunicationDocument',
  'CommunicationContent',
]);
const VERSION_CONFIG_RECORD_SUFFIX = 'VersionConfigRec';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toLowerLeadingChar(value) {
  if (typeof value !== 'string' || !value.length) {
    return '';
  }

  return value.charAt(0).toLowerCase() + value.slice(1);
}

function getShortName(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const shortName =
    item.ConfigurationInfo?.ShortName ||
    item.configurationInfo?.shortName ||
    item.configurationInfo?.ShortName;

  return typeof shortName === 'string' ? shortName.trim() : '';
}

function getConfigurationId(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const candidates = [
    item.ConfigurationId,
    item.configurationId,
    item.ConfigID,
    item.configId,
    item.Id,
    item.id,
    item.ConfigurationInfo?.ConfigurationId,
    item.configurationInfo?.ConfigurationId,
    item.configurationInfo?.configurationId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }

  return '';
}

function findObjectByKeys(node, targetKeys) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      const match = findObjectByKeys(entry, targetKeys);

      if (match) {
        return match;
      }
    }

    return null;
  }

  for (const [key, value] of Object.entries(node)) {
    if (targetKeys.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      return value;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const match = findObjectByKeys(value, targetKeys);

      if (match) {
        return match;
      }
    }
  }

  return null;
}

function toDisplayDomainName(domainName) {
  const normalized = normalizeText(domainName);

  if (!normalized) {
    return '';
  }

  return normalized.replace(/^Communication/i, '');
}

function flattenDomainRows(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }

  const rows = [];

  for (const [domainName, entries] of Object.entries(payload)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const topRecName = normalizeText(entry.TopRecName || entry.topRecName);
      const recUuid = normalizeText(entry.RecUuid || entry.recUuid);

      if (!recUuid) {
        continue;
      }

      rows.push({
        domainName: normalizeText(domainName),
        domainNameDisplay: toDisplayDomainName(domainName),
        topRecName,
        recUuid,
        versionName: normalizeText(entry.VersionName || entry.versionName),
        name: normalizeText(entry.Name || entry.name),
      });
    }
  }

  rows.sort((left, right) =>
    left.domainNameDisplay.localeCompare(right.domainNameDisplay, undefined, { sensitivity: 'base' }) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
    left.versionName.localeCompare(right.versionName, undefined, { sensitivity: 'base' }) ||
    left.recUuid.localeCompare(right.recUuid, undefined, { sensitivity: 'base' }),
  );

  return rows;
}

function extractVersionLookup(payload, domainName) {
  const normalizedDomainName = normalizeText(domainName);

  if (!normalizedDomainName) {
    return {
      domainConfigUuid: '',
      versionName: '',
    };
  }

  const versionConfigInfoKey = `${normalizedDomainName}VersionConfigInfo`;
  const versionInfo = findObjectByKeys(payload, new Set([
    versionConfigInfoKey,
    toLowerLeadingChar(versionConfigInfoKey),
  ]));
  const domainConfigUuidKey = `${normalizedDomainName}ConfigUuid`;
  const domainConfigUuid = normalizeText(
    versionInfo?.[domainConfigUuidKey] || versionInfo?.[toLowerLeadingChar(domainConfigUuidKey)],
  );
  const versionName = normalizeText(versionInfo?.ShortName || versionInfo?.shortName);

  return {
    domainConfigUuid,
    versionName,
  };
}

function extractDomainName(payload, domainName) {
  const normalizedDomainName = normalizeText(domainName);

  if (!normalizedDomainName) {
    return '';
  }

  const configInfoKey = `${normalizedDomainName}ConfigInfo`;
  const domainInfo = findObjectByKeys(payload, new Set([
    configInfoKey,
    toLowerLeadingChar(configInfoKey),
  ]));

  return normalizeText(domainInfo?.ShortName || domainInfo?.shortName);
}

function isVersionRecordRow(row) {
  const domainName = normalizeText(row?.domainName);
  const topRecName = normalizeText(row?.topRecName);

  if (!domainName || !topRecName) {
    return false;
  }

  const expectedTopRecName = `${domainName}${VERSION_CONFIG_RECORD_SUFFIX}`;

  return expectedTopRecName.toLowerCase() === topRecName.toLowerCase();
}

function getRowLookupKey(domainName, recUuid) {
  return `${normalizeText(domainName).toLowerCase()}::${normalizeText(recUuid)}`;
}

function getDomainName(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  return normalizeText(item.DomainName || item.domainName);
}

function getRecUuid(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const candidates = [item.RecUuid, item.recUuid, item.RecUUID, item.recuuid];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function getTopRecName(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const candidates = [
    item.TopRecName,
    item.topRecName,
    item.RecName,
    item.recName,
    item.Name,
    item.name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function getStatusEntries(item) {
  if (!item || typeof item !== 'object') {
    return [];
  }

  const statusValue = item.Status || item.status;

  if (Array.isArray(statusValue)) {
    return statusValue;
  }

  if (statusValue && typeof statusValue === 'object') {
    return [statusValue];
  }

  if (typeof statusValue === 'string') {
    return [statusValue];
  }

  return [];
}

function isActiveStatusEntry(statusEntry) {
  if (typeof statusEntry === 'string') {
    return statusEntry.trim().toLowerCase() === 'active';
  }

  if (!statusEntry || typeof statusEntry !== 'object') {
    return false;
  }

  const statusCode = normalizeText(
    statusEntry.StatusCode ||
      statusEntry.statusCode ||
      statusEntry.Code ||
      statusEntry.code,
  );

  return statusCode.toLowerCase() === 'active';
}

function hasActiveStatus(item) {
  return getStatusEntries(item).some((entry) => isActiveStatusEntry(entry));
}

function extractRecordCandidates(domainNode) {
  const keysToScan = ['Items', 'items', 'Records', 'records', 'Data', 'data', 'Children', 'children'];
  const records = [];

  for (const key of keysToScan) {
    const value = domainNode[key];

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object') {
          records.push(entry);
        }
      }
    }
  }

  if (!records.length && (getRecUuid(domainNode) || getTopRecName(domainNode))) {
    records.push(domainNode);
  }

  return records;
}

function ensureDomainSummary(summaryMap, domainName) {
  if (!summaryMap[domainName]) {
    summaryMap[domainName] = [];
  }

  return summaryMap[domainName];
}

function addDomainResult(summaryMap, dedupeSetMap, domainName, record) {
  const recUuid = getRecUuid(record);

  if (!recUuid || hasActiveStatus(record)) {
    return;
  }

  const topRecName = getTopRecName(record);
  const domainEntries = ensureDomainSummary(summaryMap, domainName);

  if (!dedupeSetMap[domainName]) {
    dedupeSetMap[domainName] = new Set();
  }

  const dedupeKey = `${recUuid}::${topRecName}`;

  if (dedupeSetMap[domainName].has(dedupeKey)) {
    return;
  }

  dedupeSetMap[domainName].add(dedupeKey);
  domainEntries.push({
    TopRecName: topRecName,
    RecUuid: recUuid,
  });
}

function collectDomainWiseInactiveRecords(payload) {
  const summaryMap = {};
  const dedupeSetMap = {};

  function visit(node) {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      for (const entry of node) {
        visit(entry);
      }

      return;
    }

    const domainName = getDomainName(node);

    if (TARGET_DOMAINS.has(domainName)) {
      const records = extractRecordCandidates(node);

      for (const record of records) {
        addDomainResult(summaryMap, dedupeSetMap, domainName, record);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value);
      }
    }
  }

  visit(payload);

  for (const domainName of Object.keys(summaryMap)) {
    summaryMap[domainName].sort((left, right) =>
      left.TopRecName.localeCompare(right.TopRecName, undefined, { sensitivity: 'base' }),
    );
  }

  return summaryMap;
}

async function enrichDomainRows(summaryMap, session, verbose = false) {
  const rows = flattenDomainRows(summaryMap);
  const lookupByRow = {};

  for (const row of rows) {
    if (!isVersionRecordRow(row)) {
      continue;
    }

    const lookupKey = getRowLookupKey(row.domainName, row.recUuid);

    if (lookupByRow[lookupKey]) {
      continue;
    }

    const versionPayload = await get(
      session,
      `/api/${row.domainName}/v1/${row.domainName}VersionMasterConfig/${encodeURIComponent(row.recUuid)}`,
      {},
      verbose,
    );
    const versionLookup = extractVersionLookup(versionPayload, row.domainName);
    const domainConfigUuid = versionLookup.domainConfigUuid;
    const versionName = versionLookup.versionName;
    let name = '';

    if (domainConfigUuid) {
      const namePayload = await get(
        session,
        `/api/${row.domainName}/v1/${row.domainName}MasterConfig/${encodeURIComponent(domainConfigUuid)}`,
        { depth: true },
        verbose,
      );
      name = extractDomainName(namePayload, row.domainName);
    }

    lookupByRow[lookupKey] = {
      DomainConfigUuid: domainConfigUuid,
      VersionName: versionName,
      Name: name,
    };
  }

  for (const [domainName, entries] of Object.entries(summaryMap)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    const domainConfigUuidKey = `${domainName}ConfigUuid`;

    for (const entry of entries) {
      const recUuid = normalizeText(entry.RecUuid || entry.recUuid);
      const lookupKey = getRowLookupKey(domainName, recUuid);
      const lookup = lookupByRow[lookupKey];

      if (!lookup) {
        continue;
      }

      entry[domainConfigUuidKey] = lookup.DomainConfigUuid;
      entry.VersionName = lookup.VersionName;
      entry.Name = lookup.Name;
    }
  }
}

async function fetchOpenConfigurations(session, verbose = false) {
  const configs = await paginate(
    session,
    '/api/ConfigurationId/v1/ConfigurationRec',
    {
      depth: true,
      summary: true,
      totalResults: true,
      whr: '%7B%22t%22%3A%5B%22ConfigurationStatus.ConfigurationStatusCode%22%2C%22eq%22%2C%22Open%22%5D%7D',
    },
    30,
    verbose,
  );

  return configs
    .map((item) => ({
      configurationId: getConfigurationId(item.ConfigurationRec || item),
      shortName: getShortName(item.ConfigurationRec || item),
      raw: item,
    }))
    .filter((item) => item.configurationId);
}

async function analyzeConfiguration(session, configuration, verbose = false) {
  const detailPayload = await get(
    session,
    '/api/ConfigurationId/v1/ConfigurationRec/id',
    {
      value: configuration.configurationId,
      depth: true,
      registry: true,
    },
    verbose,
  );
  const inactiveRecords = collectDomainWiseInactiveRecords(detailPayload);
  await enrichDomainRows(inactiveRecords, session, verbose);
  const rows = flattenDomainRows(inactiveRecords).filter((row) =>
    Boolean(row.domainNameDisplay && (row.name || row.versionName)),
  );

  return {
    configurationId: configuration.configurationId,
    shortName: configuration.shortName,
    hasInflightItems: rows.length > 0,
    inflightCount: rows.length,
    rows,
    detailPayload,
    inactiveRecords,
  };
}

function renderResultSummary(results) {
  if (!results.length) {
    console.log(chalk.yellow('No matching configurations were found.'));
    return;
  }

  const withInflight = results.filter((result) => result.hasInflightItems);

  if (!withInflight.length) {
    console.log(chalk.green('✅ No in-flight items found in the scanned ConfigIDs.'));
    return;
  }

  console.log(chalk.yellow(`⚠ Found ${withInflight.length} ConfigID(s) with in-flight items:\n`));

  for (const result of withInflight) {
    console.log(`- ${chalk.cyan(result.configurationId)}${result.shortName ? ` (${result.shortName})` : ''}: ${result.inflightCount} item(s)`);

    for (const row of result.rows) {
      const name = row.name || '--';
      const versionName = row.versionName || '--';
      console.log(`  ${row.domainNameDisplay}: ${name} | ${versionName}`);
    }
  }
}

export async function preflightCommand(cmd) {
  const session = loadSession();
  const outputDir = cmd.output || './output/preflight';
  ensureDir(outputDir);

  console.log("(>'-')> Running preflight scan for in-flight records...\n");

  const openConfigurations = await fetchOpenConfigurations(session, cmd.verbose);
  const requestedConfigId = normalizeText(cmd.configId);
  const configurationsToScan = requestedConfigId
    ? openConfigurations.filter((item) => item.configurationId === requestedConfigId)
    : openConfigurations;

  if (requestedConfigId && !configurationsToScan.length) {
    console.error(chalk.red(`❌ ConfigID ${requestedConfigId} was not found in the open configuration list.`));
    process.exit(1);
  }

  const results = [];

  for (const configuration of configurationsToScan) {
    console.log(`Checking ${chalk.cyan(configuration.configurationId)}${configuration.shortName ? ` (${configuration.shortName})` : ''}...`);
    const result = await analyzeConfiguration(session, configuration, cmd.verbose);
    const folderName = configuration.shortName || configuration.configurationId;
    const artifactDir = path.join(outputDir, safePathSegment(folderName));
    ensureDir(artifactDir);
    writeJSON(path.join(artifactDir, `${safePathSegment(configuration.configurationId)}.json`), {
      configurationId: result.configurationId,
      shortName: result.shortName,
      hasInflightItems: result.hasInflightItems,
      inflightCount: result.inflightCount,
      rows: result.rows,
      inactiveRecords: result.inactiveRecords,
    });
    results.push(result);
  }

  const summary = {
    scannedAt: new Date().toISOString(),
    scannedCount: results.length,
    withInflightCount: results.filter((result) => result.hasInflightItems).length,
    results: results.map((result) => ({
      configurationId: result.configurationId,
      shortName: result.shortName,
      hasInflightItems: result.hasInflightItems,
      inflightCount: result.inflightCount,
      rows: result.rows,
    })),
  };

  writeJSON(path.join(outputDir, 'summary.json'), summary);
  renderResultSummary(results);
  console.log(`\n✅ Preflight report saved to ${outputDir}`);
}
