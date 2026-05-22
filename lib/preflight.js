import path from 'path';
import chalk from 'chalk';
import { get, paginate } from './api.js';
import { loadSession } from './session.js';
import { handleAxiosError } from './errorHandler.js';
import { ensureDir, safePathSegment, writeJSON } from './utils.js';

const TARGET_DOMAINS = new Set([
  'CommunicationPackage',
  'CommunicationDocument',
  'CommunicationContent',
]);
const VERSION_CONFIG_RECORD_SUFFIX = 'VersionConfigRec';
const PACKAGE_DOCUMENT_RELATION_TOP_REC_NAME = 'CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeIdToken(value) {
  const text = normalizeText(value);

  if (!text) {
    return '';
  }

  // Normalize copied punctuation variants from UI/email/chat into plain ASCII separators.
  return text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .toLowerCase();
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

function getLongName(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  const longName =
    item.ConfigurationInfo?.LongName ||
    item.configurationInfo?.longName ||
    item.configurationInfo?.LongName;

  return typeof longName === 'string' ? longName.trim() : '';
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

function buildConfigIdentitySet(configuration) {
  const keys = [
    configuration?.configurationId,
    configuration?.shortName,
    configuration?.longName,
  ];
  const set = new Set();

  for (const key of keys) {
    const normalized = normalizeIdToken(key);

    if (normalized) {
      set.add(normalized);
    }
  }

  return set;
}

function matchesRequestedConfiguration(configuration, requestedConfigId) {
  const requestedToken = normalizeIdToken(requestedConfigId);

  if (!requestedToken) {
    return false;
  }

  return buildConfigIdentitySet(configuration).has(requestedToken);
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
        statusCode: normalizeText(entry.StatusCode || entry.statusCode || entry.Status || entry.status),
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

  const expectedTopRecName = getVersionTopRecName(domainName);

  return expectedTopRecName.toLowerCase() === topRecName.toLowerCase();
}

function getVersionTopRecName(domainName) {
  return `${normalizeText(domainName)}${VERSION_CONFIG_RECORD_SUFFIX}`;
}

function isUuidLike(value) {
  return typeof value === 'string' && /^[A-F0-9]{32}$/i.test(value.trim());
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

function getStatusCode(record) {
  const statusEntries = getStatusEntries(record);

  for (const statusEntry of statusEntries) {
    if (typeof statusEntry === 'string' && statusEntry.trim()) {
      return statusEntry.trim();
    }

    if (statusEntry && typeof statusEntry === 'object') {
      const statusCode = normalizeText(
        statusEntry.StatusCode ||
        statusEntry.statusCode ||
        statusEntry.Code ||
        statusEntry.code,
      );

      if (statusCode) {
        return statusCode;
      }
    }
  }

  return 'Unknown';
}

function collectScalarFields(node, collector = []) {
  if (!node || typeof node !== 'object') {
    return collector;
  }

  if (Array.isArray(node)) {
    for (const entry of node) {
      collectScalarFields(entry, collector);
    }

    return collector;
  }

  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === 'object') {
      collectScalarFields(value, collector);
      continue;
    }

    collector.push({ key, value });
  }

  return collector;
}

function extractLinkedConfigUuid(record, domainToken) {
  const fields = collectScalarFields(record, []);
  const candidates = [];

  for (const field of fields) {
    const key = normalizeText(field.key);
    const lowerKey = key.toLowerCase();
    const value = normalizeText(field.value);

    if (!isUuidLike(value)) {
      continue;
    }

    if (!lowerKey.includes(domainToken.toLowerCase())) {
      continue;
    }

    if (!(lowerKey.includes('uuid') || lowerKey.includes('recuuid'))) {
      continue;
    }

    const score =
      (lowerKey.includes('version') ? 4 : 0) +
      (lowerKey.includes('configuuid') ? 2 : 0) +
      (lowerKey.includes('recuuid') ? 1 : 0);

    candidates.push({ value, score });
  }

  candidates.sort((left, right) => right.score - left.score);

  return candidates[0]?.value || '';
}

function collectPackageDocumentRelations(payload) {
  const relations = [];
  const seen = new Set();

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

    const topRecName = getTopRecName(node);
    const domainName = getDomainName(node);
    const isTargetRelation =
      domainName === 'CommunicationPackage' &&
      topRecName &&
      topRecName.toLowerCase() === PACKAGE_DOCUMENT_RELATION_TOP_REC_NAME.toLowerCase();

    if (isTargetRelation) {
      const packageVersionRecUuid = extractLinkedConfigUuid(node, 'communicationpackage');
      const documentVersionRecUuid = extractLinkedConfigUuid(node, 'communicationdocument');

      if (packageVersionRecUuid && documentVersionRecUuid) {
        const dedupeKey = `${packageVersionRecUuid}::${documentVersionRecUuid}`;

        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          relations.push({
            packageVersionRecUuid,
            documentVersionRecUuid,
            relationStatusCode: getStatusCode(node),
          });
        }
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value);
      }
    }
  }

  visit(payload);

  return relations;
}

function extractConfigurationIdentity(payload) {
  const queue = [payload];

  while (queue.length) {
    const current = queue.shift();

    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    const configurationId = getConfigurationId(current);
    const shortName = getShortName(current);
    const longName = getLongName(current);

    if (configurationId || shortName || longName) {
      return {
        configurationId,
        shortName,
        longName,
      };
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    }
  }

  return {
    configurationId: '',
    shortName: '',
    longName: '',
  };
}

function isSameConfigurationIdentity(configuration, identity) {
  const left = buildConfigIdentitySet(configuration);
  const right = buildConfigIdentitySet(identity);

  for (const token of right) {
    if (left.has(token)) {
      return true;
    }
  }

  return false;
}

async function getOrNull(session, url, params = {}, verbose = false) {
  try {
    return await get(session, url, params, verbose, { throwOnError: true });
  } catch (err) {
    if (err.response?.status === 404) {
      return null;
    }

    throw err;
  }
}

async function resolveDomainVersion(session, domainName, recUuid, verbose = false, cache = {}) {
  const cacheKey = `${domainName}::${recUuid}`;

  if (cache[cacheKey]) {
    return cache[cacheKey];
  }

  try {
    const versionPayload = await getOrNull(
      session,
      `/api/${domainName}/v1/${domainName}VersionMasterConfig/${encodeURIComponent(recUuid)}`,
      {},
      verbose,
    );

    if (!versionPayload) {
      cache[cacheKey] = null;
      return null;
    }

    const versionLookup = extractVersionLookup(versionPayload, domainName);
    const identity = extractConfigurationIdentity(versionPayload);
    let name = '';

    if (versionLookup.domainConfigUuid) {
      const masterPayload = await getOrNull(
        session,
        `/api/${domainName}/v1/${domainName}MasterConfig/${encodeURIComponent(versionLookup.domainConfigUuid)}`,
        { depth: true },
        verbose,
      );

      if (masterPayload) {
        name = extractDomainName(masterPayload, domainName);
      }
    }

    cache[cacheKey] = {
      domainName,
      domainNameDisplay: toDisplayDomainName(domainName),
      recUuid,
      name,
      versionName: versionLookup.versionName,
      statusCode: getStatusCode(versionPayload),
      ownerConfigurationId: identity.configurationId,
      ownerShortName: identity.shortName,
      ownerLongName: identity.longName,
    };
    return cache[cacheKey];
  } catch (err) {
    handleAxiosError(err, `Failed to resolve ${domainName} version ${recUuid}`);
    process.exit(1);
  }
}

async function collectBlockingChains(session, configuration, detailPayload, verbose = false) {
  const relations = collectPackageDocumentRelations(detailPayload);
  const domainLookupCache = {};
  const chains = [];

  for (const relation of relations) {
    const packageVersion = await resolveDomainVersion(
      session,
      'CommunicationPackage',
      relation.packageVersionRecUuid,
      verbose,
      domainLookupCache,
    );
    const documentVersion = await resolveDomainVersion(
      session,
      'CommunicationDocument',
      relation.documentVersionRecUuid,
      verbose,
      domainLookupCache,
    );

    if (!packageVersion || !documentVersion) {
      continue;
    }

    const ownerIdentity = {
      configurationId: documentVersion.ownerConfigurationId,
      shortName: documentVersion.ownerShortName,
      longName: documentVersion.ownerLongName,
    };
    const externalOwner =
      (ownerIdentity.configurationId || ownerIdentity.shortName || ownerIdentity.longName) &&
      !isSameConfigurationIdentity(configuration, ownerIdentity);

    chains.push({
      relationStatusCode: relation.relationStatusCode,
      packageVersion,
      documentVersion,
      externalOwner,
    });
  }

  chains.sort((left, right) =>
    (left.packageVersion.name || '').localeCompare(right.packageVersion.name || '', undefined, { sensitivity: 'base' }) ||
    (left.packageVersion.versionName || '').localeCompare(right.packageVersion.versionName || '', undefined, { sensitivity: 'base' }) ||
    (left.documentVersion.name || '').localeCompare(right.documentVersion.name || '', undefined, { sensitivity: 'base' }) ||
    (left.documentVersion.versionName || '').localeCompare(right.documentVersion.versionName || '', undefined, { sensitivity: 'base' }) ||
    (left.documentVersion.recUuid || '').localeCompare(right.documentVersion.recUuid || '', undefined, { sensitivity: 'base' }),
  );

  return chains;
}

function addDomainAttachmentResult(summaryMap, dedupeSetMap, domainName, record) {
  const recUuid = getRecUuid(record);

  if (!recUuid) {
    return;
  }

  const topRecName = getTopRecName(record);
  const expectedTopRecName = getVersionTopRecName(domainName);

  // Keep attachment mode focused on real version config records only.
  if (!topRecName || topRecName.toLowerCase() !== expectedTopRecName.toLowerCase()) {
    return;
  }

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
    StatusCode: getStatusCode(record),
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

function collectDomainWiseAttachmentRecords(payload) {
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
        addDomainAttachmentResult(summaryMap, dedupeSetMap, domainName, record);
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

    const versionPayload = await getOrHandleEnrichment404(
      session,
      `/api/${row.domainName}/v1/${row.domainName}VersionMasterConfig/${encodeURIComponent(row.recUuid)}`,
      {},
      verbose,
      row,
    );

    if (!versionPayload) {
      continue;
    }

    const versionLookup = extractVersionLookup(versionPayload, row.domainName);
    const domainConfigUuid = versionLookup.domainConfigUuid;
    const versionName = versionLookup.versionName;
    let name = '';

    if (domainConfigUuid) {
      const namePayload = await getOrHandleEnrichment404(
        session,
        `/api/${row.domainName}/v1/${row.domainName}MasterConfig/${encodeURIComponent(domainConfigUuid)}`,
        { depth: true },
        verbose,
        row,
      );

      if (namePayload) {
        name = extractDomainName(namePayload, row.domainName);
      }
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

async function getOrHandleEnrichment404(session, url, params, verbose, row) {
  try {
    return await get(session, url, params, verbose, { throwOnError: true });
  } catch (err) {
    if (err.response?.status === 404) {
      if (verbose) {
        console.log(chalk.gray(`  ↳ skipping stale record ${row.domainName}:${row.recUuid} (${url})`));
      }
      return null;
    }

    handleAxiosError(err, `Failed preflight enrichment lookup for ${row.domainName}:${row.recUuid}`);
    process.exit(1);
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
      longName: getLongName(item.ConfigurationRec || item),
      raw: item,
    }))
    .filter((item) => item.configurationId);
}

async function analyzeConfiguration(session, configuration, verbose = false) {
  const detailPayload = await fetchConfigurationDetailPayload(session, configuration, verbose);
  const inactiveRecords = collectDomainWiseInactiveRecords(detailPayload);
  await enrichDomainRows(inactiveRecords, session, verbose);
  const rows = flattenDomainRows(inactiveRecords).filter((row) =>
    Boolean(row.domainNameDisplay && (row.name || row.versionName)),
  );
  let attachedRows = [];
  let blockerChains = [];

  if (configuration.listAttached) {
    const attachmentRecords = collectDomainWiseAttachmentRecords(detailPayload);
    await enrichDomainRows(attachmentRecords, session, verbose);
    attachedRows = flattenDomainRows(attachmentRecords).filter((row) =>
      Boolean(row.domainNameDisplay && (row.name || row.versionName)),
    );
  }

  if (configuration.showBlockers) {
    blockerChains = await collectBlockingChains(session, configuration, detailPayload, verbose);
  }

  return {
    configurationId: configuration.configurationId,
    shortName: configuration.shortName,
    hasInflightItems: rows.length > 0,
    inflightCount: rows.length,
    rows,
    attachedRows,
    blockerChains,
    detailPayload,
    inactiveRecords,
  };
}

async function fetchConfigurationDetailPayload(session, configuration, verbose = false) {
  const identifierCandidates = [
    configuration?.configurationId,
    configuration?.shortName,
    configuration?.longName,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  const uniqueCandidates = [...new Set(identifierCandidates)];
  let lastError = null;

  for (const candidate of uniqueCandidates) {
    try {
      return await get(
        session,
        '/api/ConfigurationId/v1/ConfigurationRec/id',
        {
          value: candidate,
          depth: true,
          registry: true,
        },
        verbose,
        { throwOnError: true },
      );
    } catch (err) {
      if (err.response?.status !== 404) {
        handleAxiosError(err, `Failed to fetch configuration detail for ${configuration.configurationId}`);
        process.exit(1);
      }

      lastError = err;
      if (verbose) {
        console.log(chalk.gray(`  ↳ no configuration detail found for value=${candidate}`));
      }
    }
  }

  if (lastError) {
    console.error(chalk.red(`❌ Could not resolve configuration detail for ${configuration.configurationId}.`));
    console.error(chalk.yellow(`   Tried identifiers: ${uniqueCandidates.join(', ')}`));
    process.exit(1);
  }

  console.error(chalk.red('❌ No usable configuration identifier was available for detail lookup.'));
  process.exit(1);
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

function renderAttachmentSummary(results) {
  for (const result of results) {
    const attachedRows = Array.isArray(result.attachedRows) ? result.attachedRows : [];

    console.log(`\nAttached items for ${chalk.cyan(result.configurationId)}${result.shortName ? ` (${result.shortName})` : ''}:`);

    if (!attachedRows.length) {
      console.log(chalk.yellow('  (none found)'));
      continue;
    }

    for (const row of attachedRows) {
      const name = row.name || '--';
      const versionName = row.versionName || '--';
      const statusCode = row.statusCode || 'Unknown';
      console.log(`  ${row.domainNameDisplay}: ${name} | ${versionName} | ${statusCode}`);
    }
  }
}

function formatOwnerLabel(row) {
  const id = normalizeText(row.ownerConfigurationId);
  const shortName = normalizeText(row.ownerShortName);
  const longName = normalizeText(row.ownerLongName);

  if (id && shortName) {
    return `${id} (${shortName})`;
  }

  if (shortName) {
    return shortName;
  }

  if (id) {
    return id;
  }

  if (longName) {
    return longName;
  }

  return 'Unknown';
}

function renderBlockerSummary(results) {
  for (const result of results) {
    const blockerChains = Array.isArray(result.blockerChains) ? result.blockerChains : [];
    const externalChains = blockerChains.filter((chain) => chain.externalOwner);

    console.log(`\nBlocker chains for ${chalk.cyan(result.configurationId)}${result.shortName ? ` (${result.shortName})` : ''}:`);

    if (!externalChains.length) {
      console.log(chalk.green('  No cross-config document blockers were identified.'));
      continue;
    }

    for (const chain of externalChains) {
      const packageName = chain.packageVersion.name || chain.packageVersion.recUuid;
      const packageVersion = chain.packageVersion.versionName || '--';
      const documentName = chain.documentVersion.name || chain.documentVersion.recUuid;
      const documentVersion = chain.documentVersion.versionName || '--';
      const ownerLabel = formatOwnerLabel(chain.documentVersion);
      console.log(`  Package ${packageName} | ${packageVersion}`);
      console.log(`    blocked by Document ${documentName} | ${documentVersion} | owner ${ownerLabel} | relation ${chain.relationStatusCode || 'Unknown'}`);
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
    ? openConfigurations
      .filter((item) => matchesRequestedConfiguration(item, requestedConfigId))
      .map((item) => ({
        ...item,
        listAttached: Boolean(cmd.listAttached),
        showBlockers: Boolean(cmd.showBlockers),
      }))
    : openConfigurations.map((item) => ({
      ...item,
      listAttached: Boolean(cmd.listAttached),
      showBlockers: Boolean(cmd.showBlockers),
    }));

  if (requestedConfigId && !configurationsToScan.length) {
    console.error(chalk.red(`❌ ConfigID ${requestedConfigId} was not found in the open configuration list.`));
    console.error(chalk.yellow('   Tip: values passed to `-c` can be the ConfigurationId, ShortName, or LongName shown in CCS.'));
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
      attachedRows: result.attachedRows,
      blockerChains: result.blockerChains,
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
      attachedRows: result.attachedRows,
      blockerChains: result.blockerChains,
    })),
  };

  writeJSON(path.join(outputDir, 'summary.json'), summary);
  renderResultSummary(results);

  if (cmd.listAttached) {
    renderAttachmentSummary(results);
  }

  if (cmd.showBlockers) {
    renderBlockerSummary(results);
  }

  console.log(`\n✅ Preflight report saved to ${outputDir}`);
}
