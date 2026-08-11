import axios from 'axios';
import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { loadSession, saveSession } from './session.js';
import { ensureDir, safePathSegment, stringifyJSON, writeJSON, writeStdoutJSON } from './utils.js';
import { getDocumentMasterSummary } from './documents.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';

const BUNDLE_SCHEMA_VERSION = 'occs-package-bundle/v1';
const ASSEMBLY_TEMPLATE_FILE = 'assembly-template.json';
const VERSION_MASTER_FILE = 'version-master.json';
const DOCUMENT_ASSOCIATIONS_FILE = 'document-associations.json';
const MANIFEST_FILE = 'occs-package.json';
const VERSION_MASTER_SAVE_KEYS = [
  'CommunicationPackageConfigRec',
  'CommunicationPackageVersionConfigRec',
  'CommunicationPackageVersionDocuments',
  'CompanyCommunicationPackages',
];

function optsWithGlobals(cmd) {
  return typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : (cmd || {});
}

function sessionSelector(opts = {}) {
  return {
    sessionName: opts.session,
    customer: opts.customer,
    region: opts.region ?? opts.environment,
    tenancy: opts.tenancy,
  };
}

function writeJson(payload) {
  writeStdoutJSON(payload);
}

function commandError(message, details = undefined) {
  const err = new Error(message);
  err.details = details;
  return err;
}

function errorDetails(err) {
  if (err?.details) {
    return err.details;
  }

  if (err?.response) {
    const data = err.response.data;
    const responseText = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    return {
      status: err.response.status,
      statusText: err.response.statusText,
      response: responseText,
    };
  }

  return undefined;
}

function withApiContext(err, context) {
  const details = errorDetails(err);
  err.details = {
    ...context,
    ...(details || {}),
  };
  return err;
}

async function runCommand(opts, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err?.message || String(err);
    const details = errorDetails(err);
    if (opts.json) {
      writeJson({
        ok: false,
        error: {
          message,
          ...(details ? { details } : {}),
        },
      });
    } else {
      console.error(chalk.red(`❌ ${message}`));
      if (opts.verbose && details) {
        console.error(details);
      }
    }
    process.exit(1);
  }
}

function log(opts, message) {
  if (opts.json) {
    console.error(message);
  } else {
    console.log(message);
  }
}

function apiUrl(session, url) {
  return `${String(session.baseUrl || '').replace(/\/$/, '')}${url}`;
}

function authHeaders(session, extra = {}) {
  return {
    Authorization: `Bearer ${session.token}`,
    Accept: 'application/json',
    ...extra,
  };
}

async function apiGetJson(session, url, params = {}, opts = {}) {
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ GET ${fullUrl}`));
  }

  const res = await axios.get(fullUrl, {
    headers: authHeaders(session, opts.headers),
    params,
    timeout: resolveRequestTimeoutMs(opts.timeout),
  });
  return res.data;
}

async function apiPaginate(session, url, params = {}, limit = 50, opts = {}) {
  let offset = 0;
  let totalResults = null;
  let hasMore = true;
  const items = [];

  while (hasMore) {
    const page = await apiGetJson(session, url, { ...params, offset, limit }, opts);
    const pageItems = page.Items || [];
    items.push(...pageItems);
    if (page.TotalResults !== undefined) {
      totalResults = page.TotalResults;
    }
    hasMore = Boolean(page.HasMore) || pageItems.length === limit;
    offset += limit;
  }

  return {
    items,
    totalResults: totalResults ?? items.length,
  };
}

async function apiGetAssemblyTemplate(session, versionUuid, opts = {}) {
  const url = `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${versionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`;
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ GET ${fullUrl}`));
  }

  const res = await axios.get(fullUrl, {
    headers: authHeaders(session),
    responseType: 'arraybuffer',
    timeout: resolveRequestTimeoutMs(opts.timeout),
  });
  const text = Buffer.from(res.data).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw commandError('Assembly template response was not valid JSON.', {
      url,
      bytes: Buffer.byteLength(text),
    });
  }
}

async function apiPutJson(session, url, payload, transactionConfigId, opts = {}) {
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ PUT ${fullUrl}`));
  }

  try {
    const res = await axios.put(fullUrl, payload, {
      headers: authHeaders(session, {
        'Content-Type': 'application/json',
        transactionconfigid: String(transactionConfigId),
      }),
      timeout: resolveRequestTimeoutMs(opts.timeout),
    });
    return res.data;
  } catch (err) {
    throw withApiContext(err, {
      method: 'PUT',
      url: fullUrl,
      apiPath: url,
      surface: 'versionMaster',
    });
  }
}

async function apiPutAssemblyTemplate(session, versionUuid, assemblyTemplate, transactionConfigId, opts = {}) {
  const url = `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${versionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`;
  const fullUrl = apiUrl(session, url);
  if (opts.verbose) {
    console.error(chalk.gray(`→ PUT ${fullUrl}`));
  }

  const boundary = `----occs-cli-${crypto.randomBytes(12).toString('hex')}`;
  const jsonText = stringifyJSON(assemblyTemplate, { pretty: opts.pretty });
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name=""; filename="blob"',
    'Content-Type: application/octet-stream',
    '',
    jsonText,
    `--${boundary}--`,
    '',
  ].join('\r\n'), 'utf8');

  try {
    const res = await axios.put(fullUrl, body, {
      headers: authHeaders(session, {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
        transactionconfigid: String(transactionConfigId),
      }),
      timeout: resolveRequestTimeoutMs(opts.timeout),
    });
    return res.data;
  } catch (err) {
    throw withApiContext(err, {
      method: 'PUT',
      url: fullUrl,
      apiPath: url,
      surface: 'assemblyTemplate',
    });
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw commandError(`Failed to read ${label}: ${filePath}`, err.message);
  }
}

function packageSearchWhere(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return undefined;
  return JSON.stringify({
    a: [
      {
        t: ['CommunicationPackageConfigInfo.ShortName', 'lk', `%${trimmed}%`],
      },
    ],
  });
}

function packageSummary(item) {
  const rec = item.CommunicationPackageConfigRec || {};
  const info = rec.CommunicationPackageConfigInfo || {};
  const config = item.ConfigurationRec || {};
  const configInfo = config.ConfigurationInfo || {};
  return {
    name: info.Name || '',
    shortName: info.ShortName || '',
    description: info.Desc || '',
    packageUuid: rec.CommunicationPackageConfigUuid || '',
    configId: rec.ConfigId || info.ConfigId || '',
    configuration: config.ConfigurationId ? {
      id: config.ConfigurationId,
      uuid: config.ConfigurationUuid || '',
      shortName: configInfo.ShortName || '',
      name: configInfo.Name || '',
    } : null,
  };
}

async function searchPackages(session, name, opts = {}) {
  const params = {
    depth: true,
    summary: true,
    totalResults: true,
  };
  const whr = packageSearchWhere(name);
  if (whr) {
    params.whr = whr;
  }

  const result = await apiPaginate(
    session,
    '/api/CommunicationPackage/v1/CommunicationPackageConfigRec',
    params,
    49,
    opts
  );

  return {
    hasMore: false,
    totalResults: result.totalResults,
    packages: result.items.map(packageSummary),
  };
}

async function resolvePackage(session, name, opts = {}) {
  const result = await searchPackages(session, name, opts);
  const wanted = String(name || '').trim().toLowerCase();
  const exact = result.packages.filter((pkg) => String(pkg.shortName || '').toLowerCase() === wanted);
  const candidates = exact.length ? exact : result.packages;

  if (candidates.length === 0) {
    throw commandError(`Package not found: ${name}`);
  }
  if (candidates.length > 1) {
    throw commandError(`Package name is ambiguous: ${name}`, {
      matches: candidates.map((pkg) => pkg.shortName),
    });
  }
  return candidates[0];
}

function parseVersionNumber(value) {
  const parts = String(value || '').match(/\d+(?:\.\d+)*/)?.[0];
  if (!parts) return null;
  return parts.split('.').map((part) => Number(part));
}

function compareVersionNames(a, b) {
  const left = parseVersionNumber(a.shortName);
  const right = parseVersionNumber(b.shortName);
  if (left && right) {
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      const delta = (right[i] || 0) - (left[i] || 0);
      if (delta) return delta;
    }
  }
  if (left && !right) return -1;
  if (!left && right) return 1;
  return String(b.shortName || '').localeCompare(String(a.shortName || ''), undefined, { numeric: true });
}

function versionSummary(versionItem) {
  const rec = versionItem.CommunicationPackageVersionConfigRec || {};
  const info = rec.CommunicationPackageVersionConfigInfo || {};
  const template = info.DocumentJSONPathAssemblyTemplate || {};
  return {
    shortName: info.ShortName || '',
    description: info.Desc || '',
    versionUuid: rec.CommunicationPackageVersionConfigUuid || '',
    configId: info.ConfigId || rec.ConfigId || '',
    assemblyTemplate: {
      fileId: template.FileId || '',
      location: template.Location || '',
      configId: template.ConfigId || '',
    },
  };
}

function resolveVersion(master, rawVersion) {
  const versions = (master.CommunicationPackageMasterVersions || []).map(versionSummary);
  if (versions.length === 0) {
    throw commandError('Package has no versions.');
  }

  const requested = String(rawVersion || 'latest').trim();
  if (!requested || requested.toLowerCase() === 'latest') {
    return [...versions].sort(compareVersionNames)[0];
  }

  const matches = versions.filter((version) => String(version.shortName || '').toLowerCase() === requested.toLowerCase());
  if (matches.length === 0) {
    throw commandError(`Package version not found: ${requested}`, {
      availableVersions: versions.map((version) => version.shortName),
    });
  }
  if (matches.length > 1) {
    throw commandError(`Package version is ambiguous: ${requested}`);
  }
  return matches[0];
}

function defaultBundlePath(packageName, versionName) {
  return path.resolve(process.cwd(), `${safePathSegment(packageName)}-${safePathSegment(versionName)}`);
}

function prepareOutputDir(outputPath, force) {
  if (fs.existsSync(outputPath)) {
    const entries = fs.readdirSync(outputPath);
    if (entries.length > 0 && !force) {
      throw commandError(`Output directory already exists and is not empty: ${outputPath}`, {
        hint: 'Pass --force to overwrite the bundle files.',
      });
    }
  }
  ensureDir(outputPath);
}

function normalizeStatusShape(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStatusShape(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'Status' && child && typeof child === 'object' && Array.isArray(child.Items)) {
        return [key, child.Items.map((item) => normalizeStatusShape(item))];
      }
      return [key, normalizeStatusShape(child)];
    })
  );
}

function omitKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key))
  );
}

function normalizeTopLevelConfigRec(rec) {
  return omitKeys(normalizeStatusShape(rec), ['ConfigId']);
}

function normalizeVersionDocumentRel(item) {
  const rec = item?.CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec || {};
  return {
    CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec: {
      CommunicationPackageVersionConfigCommunicationDocumentConfigRelInfo: {
        ...(rec.CommunicationPackageVersionConfigCommunicationDocumentConfigRelInfo || {}),
      },
      ...(rec.CommunicationPackageVersionConfigCommunicationDocumentConfigRelUuid ? {
        CommunicationPackageVersionConfigCommunicationDocumentConfigRelUuid:
          rec.CommunicationPackageVersionConfigCommunicationDocumentConfigRelUuid,
      } : {}),
    },
  };
}

function normalizeCompanyPackageRel(item) {
  const rec = item?.CompanyCommunicationPackageConfigRelRec || {};
  const info = omitKeys(rec.CompanyCommunicationPackageConfigRelInfo || {}, ['ConfigId']);
  return {
    CompanyCommunicationPackageConfigRelRec: {
      CompanyCommunicationPackageConfigRelInfo: info,
      ...(rec.CompanyCommunicationPackageConfigRelUuid ? {
        CompanyCommunicationPackageConfigRelUuid: rec.CompanyCommunicationPackageConfigRelUuid,
      } : {}),
    },
  };
}

function versionMasterSavePayload(versionMaster) {
  const payload = Object.fromEntries(
    VERSION_MASTER_SAVE_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(versionMaster, key))
      .map((key) => [key, versionMaster[key]])
  );

  if (payload.CommunicationPackageConfigRec) {
    payload.CommunicationPackageConfigRec = normalizeTopLevelConfigRec(payload.CommunicationPackageConfigRec);
  }

  if (payload.CommunicationPackageVersionConfigRec) {
    payload.CommunicationPackageVersionConfigRec = normalizeTopLevelConfigRec(payload.CommunicationPackageVersionConfigRec);
  }

  payload.CommunicationPackageVersionDocuments = (payload.CommunicationPackageVersionDocuments || [])
    .map(normalizeVersionDocumentRel);

  payload.CompanyCommunicationPackages = (payload.CompanyCommunicationPackages || [])
    .map(normalizeCompanyPackageRel);

  return payload;
}

function relativeBundleFiles() {
  return {
    manifest: MANIFEST_FILE,
    assemblyTemplate: ASSEMBLY_TEMPLATE_FILE,
    versionMaster: VERSION_MASTER_FILE,
    documentAssociations: DOCUMENT_ASSOCIATIONS_FILE,
  };
}

function absoluteBundleFiles(bundlePath) {
  return Object.fromEntries(
    Object.entries(relativeBundleFiles()).map(([key, file]) => [key, path.join(bundlePath, file)])
  );
}

function associationRelRecord(item) {
  return item?.CommunicationPackageVersionConfigCommunicationDocumentConfigRelRec || {};
}

function associationRelInfo(item) {
  return associationRelRecord(item).CommunicationPackageVersionConfigCommunicationDocumentConfigRelInfo || {};
}

function isUnauthorizedError(error) {
  return Number(error?.response?.status) === 401;
}

async function refreshSessionToken(session, opts = {}) {
  const credentialSession = loadSession({
    sessionName: session.sessionKey,
    includeCredentials: true,
  });
  if (!credentialSession.username || !credentialSession.password) {
    throw new Error(
      'The OCCS session expired while resolving package document associations, but no saved credentials are available to refresh it. Run `occs login` and retry the package download.',
    );
  }

  const response = await axios.post(
    `${String(session.baseUrl || '').replace(/\/$/, '')}/api/oauth2/v1/access`,
    { User: credentialSession.username, Password: credentialSession.password },
    {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: resolveRequestTimeoutMs(opts.timeout),
    },
  );
  const token = response.data?.AccessToken;
  if (!token) {
    throw new Error('No token returned while refreshing the OCCS session.');
  }

  session.token = token;
  saveSession({ ...session, username: undefined, password: undefined }, {
    sessionKey: session.sessionKey,
    makeCurrent: false,
  });
}

async function resolveDocumentAssociationCatalog(session, versionMaster, opts = {}) {
  const rels = versionMaster.CommunicationPackageVersionDocuments || [];
  const byUuid = new Map();
  const rows = [];

  let refreshedSession = false;
  for (const item of rels) {
    const info = associationRelInfo(item);
    const documentUuid = String(info.CommunicationDocumentConfigUuid || '').trim();
    if (!documentUuid || byUuid.has(documentUuid)) {
      continue;
    }

    try {
      byUuid.set(documentUuid, await getDocumentMasterSummary(session, documentUuid, {
        ...opts,
        throwOnError: true,
      }));
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        byUuid.set(documentUuid, {
          uuid: documentUuid,
          name: '',
          shortName: '',
          description: '',
          configId: '',
          error: error?.message || String(error),
        });
        continue;
      }
      if (refreshedSession) {
        throw new Error(`OCCS rejected the refreshed session while resolving document association ${documentUuid}. Package download aborted to avoid writing incomplete association metadata.`, { cause: error });
      }

      refreshedSession = true;
      console.warn(chalk.yellow('⚠ OCCS session expired while resolving package document associations; refreshing it and retrying.'));
      await refreshSessionToken(session, opts);
      try {
        byUuid.set(documentUuid, await getDocumentMasterSummary(session, documentUuid, {
          ...opts,
          throwOnError: true,
        }));
      } catch (retryError) {
        throw new Error(`Could not resolve document association ${documentUuid} after refreshing the OCCS session. Package download aborted to avoid writing incomplete association metadata.`, { cause: retryError });
      }
    }
  }

  for (const item of rels) {
    const rec = associationRelRecord(item);
    const info = associationRelInfo(item);
    const documentUuid = String(info.CommunicationDocumentConfigUuid || '').trim();
    const document = byUuid.get(documentUuid) || {};
    rows.push({
      relUuid: rec.CommunicationPackageVersionConfigCommunicationDocumentConfigRelUuid || '',
      documentConfigUuid: documentUuid,
      documentShortName: document.shortName || '',
      documentName: document.name || '',
      documentDescription: document.description || '',
      documentConfigId: document.configId || '',
      documentRelIndex: info.DocumentRelIndex ?? null,
      documentAlwaysTriggerInd: Boolean(info.DocumentAlwaysTriggerInd),
      packageVersionConfigUuid: info.CommunicationPackageVersionConfigUuid || '',
      configId: info.ConfigId || '',
      resolved: Boolean(document.shortName),
      ...(document.error ? { resolveError: document.error } : {}),
    });
  }

  return {
    schemaVersion: 'occs-document-associations/v1',
    generatedAt: new Date().toISOString(),
    count: rows.length,
    documents: [...byUuid.values()],
    associations: rows,
  };
}

function buildManifest({ session, pkg, version, versionMaster, assemblyTemplate, documentAssociations, bundlePath }) {
  const files = relativeBundleFiles();
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      baseUrl: session.baseUrl,
      sessionKey: session.sessionKey || '',
      fetchedWithoutConfigId: true,
    },
    package: {
      name: pkg.name,
      shortName: pkg.shortName,
      uuid: pkg.packageUuid,
    },
    version: {
      shortName: version.shortName,
      uuid: version.versionUuid,
    },
    files,
    api: {
      packageMaster: `/api/CommunicationPackage/v1/CommunicationPackageMasterConfig/${pkg.packageUuid}`,
      versionMaster: `/api/CommunicationPackage/v1/CommunicationPackageVersionMasterConfig/${version.versionUuid}`,
      assemblyTemplate: `/api/CommunicationPackage/v1/CommunicationPackageVersionConfigRec/${version.versionUuid}/CommunicationPackageVersionConfigInfo/DocumentJSONPathAssemblyTemplate`,
    },
    sourceHashes: {
      assemblyTemplate: semanticHash(assemblyTemplate),
      versionMaster: semanticHash(versionMasterSavePayload(versionMaster)),
      documentAssociations: semanticHash(documentAssociations),
    },
    bundlePath,
  };
}

async function resolveConfigId(session, input, opts = {}) {
  const wanted = String(input || '').trim();
  if (!wanted) {
    throw commandError('Missing required --config-id value.');
  }

  const params = {
    depth: true,
    totalResults: true,
    whr: JSON.stringify({
      t: ['ConfigurationStatus.ConfigurationStatusCode', 'eq', 'Open'],
    }),
  };

  const result = await apiPaginate(
    session,
    '/api/ConfigurationId/v1/ConfigurationRec',
    params,
    100,
    opts
  );

  const configs = result.items.map((item) => {
    const info = item.ConfigurationInfo || {};
    const statusItems = item.ConfigurationStatus?.Items || [];
    return {
      id: String(item.ConfigurationId || ''),
      uuid: item.ConfigurationUuid || '',
      shortName: info.ShortName || '',
      name: info.Name || '',
      description: info.Desc || '',
      status: statusItems[0]?.ConfigurationStatusCode || '',
      effectiveAt: statusItems[0]?.EffDtTm || '',
    };
  });

  const matches = configs.filter((config) => {
    return config.id === wanted
      || config.shortName.toLowerCase() === wanted.toLowerCase()
      || config.name.toLowerCase() === wanted.toLowerCase();
  });

  if (matches.length === 0) {
    throw commandError(`Open ConfigId not found: ${wanted}`);
  }
  if (matches.length > 1) {
    throw commandError(`ConfigId is ambiguous: ${wanted}`, {
      matches: matches.map((config) => ({
        id: config.id,
        shortName: config.shortName,
        name: config.name,
      })),
    });
  }

  return {
    input: wanted,
    resolved: matches[0].id,
    ...matches[0],
  };
}

function loadBundle(bundlePath) {
  const resolvedBundlePath = path.resolve(bundlePath);
  const files = absoluteBundleFiles(resolvedBundlePath);
  const manifest = readJsonFile(files.manifest, 'bundle manifest');
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw commandError(`Unsupported package bundle schema: ${manifest.schemaVersion || '(missing)'}`);
  }

  const assemblyTemplate = readJsonFile(files.assemblyTemplate, 'assembly template');
  const versionMaster = readJsonFile(files.versionMaster, 'version master');
  const documentAssociations = fs.existsSync(files.documentAssociations)
    ? readJsonFile(files.documentAssociations, 'document associations')
    : null;
  return {
    bundlePath: resolvedBundlePath,
    files,
    manifest,
    assemblyTemplate,
    versionMaster,
    documentAssociations,
  };
}

function changedSurfaces(manifest, assemblyTemplate, versionMaster) {
  const current = {
    assemblyTemplate: semanticHash(assemblyTemplate),
    versionMaster: semanticHash(versionMasterSavePayload(versionMaster)),
  };
  const source = manifest.sourceHashes || {};
  return {
    currentHashes: current,
    changes: {
      assemblyTemplate: current.assemblyTemplate !== source.assemblyTemplate,
      versionMaster: current.versionMaster !== source.versionMaster,
    },
  };
}

export async function packageListCommand(nameArg, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const name = opts.name || nameArg || '';
    const result = await searchPackages(session, name, opts);

    if (opts.json) {
      writeJson({
        ok: true,
        query: name,
        count: result.packages.length,
        totalResults: result.totalResults,
        hasMore: result.hasMore,
        packages: result.packages,
      });
      return;
    }

    for (const pkg of result.packages) {
      console.log(`${pkg.shortName}\t${pkg.packageUuid}\t${pkg.description}`);
    }
  });
}

export async function packageGetCommand(name, versionArg, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const pkg = await resolvePackage(session, name, opts);
    const packageMaster = await apiGetJson(
      session,
      `/api/CommunicationPackage/v1/CommunicationPackageMasterConfig/${pkg.packageUuid}`,
      { depth: true, limit: 30 },
      opts
    );
    const version = resolveVersion(packageMaster, opts.packageVersion || versionArg || 'latest');
    const versionMaster = await apiGetJson(
      session,
      `/api/CommunicationPackage/v1/CommunicationPackageVersionMasterConfig/${version.versionUuid}`,
      { depth: true, limit: 30 },
      opts
    );
    const assemblyTemplate = await apiGetAssemblyTemplate(session, version.versionUuid, opts);
    const documentAssociations = await resolveDocumentAssociationCatalog(session, versionMaster, opts);
    const bundlePath = path.resolve(opts.output || defaultBundlePath(pkg.shortName, version.shortName));
    prepareOutputDir(bundlePath, Boolean(opts.force));
    const files = absoluteBundleFiles(bundlePath);
    const manifest = buildManifest({
      session,
      pkg,
      version,
      versionMaster,
      assemblyTemplate,
      documentAssociations,
      bundlePath,
    });

    writeJSON(files.assemblyTemplate, assemblyTemplate);
    writeJSON(files.versionMaster, versionMasterSavePayload(versionMaster));
    writeJSON(files.documentAssociations, documentAssociations);
    writeJSON(files.manifest, manifest);

    const response = {
      ok: true,
      package: pkg.shortName,
      version: version.shortName,
      packageUuid: pkg.packageUuid,
      versionUuid: version.versionUuid,
      bundlePath,
      files,
    };

    if (opts.json) {
      writeJson(response);
    } else {
      log(opts, `Saved package bundle to ${bundlePath}`);
    }
  });
}

export async function packageSaveCommand(bundleDir, cmd) {
  const opts = optsWithGlobals(cmd);
  return runCommand(opts, async () => {
    const session = loadSession(sessionSelector(opts));
    const bundle = loadBundle(bundleDir);
    const config = await resolveConfigId(session, opts.configId, opts);
    const { currentHashes, changes } = changedSurfaces(
      bundle.manifest,
      bundle.assemblyTemplate,
      bundle.versionMaster
    );
    const needsSave = changes.versionMaster || changes.assemblyTemplate;
    const dryRun = Boolean(opts.dryRun);
    const uploadPlan = {
      versionMaster: changes.versionMaster,
      assemblyTemplate: changes.assemblyTemplate || changes.versionMaster,
    };
    const uploaded = {
      versionMaster: false,
      assemblyTemplate: false,
    };
    const responses = {};

    if (!dryRun && uploadPlan.versionMaster) {
      responses.versionMaster = await apiPutJson(
        session,
        bundle.manifest.api.versionMaster,
        versionMasterSavePayload(bundle.versionMaster),
        config.resolved,
        opts
      );
      uploaded.versionMaster = true;
    }

    if (!dryRun && uploadPlan.assemblyTemplate) {
      responses.assemblyTemplate = await apiPutAssemblyTemplate(
        session,
        bundle.manifest.version.uuid,
        bundle.assemblyTemplate,
        config.resolved,
        opts
      );
      uploaded.assemblyTemplate = true;
    }

    if (!dryRun && (uploaded.versionMaster || uploaded.assemblyTemplate)) {
      bundle.manifest.sourceHashes = currentHashes;
      bundle.manifest.lastSave = {
        savedAt: new Date().toISOString(),
        configId: {
          input: config.input,
          resolved: config.resolved,
          shortName: config.shortName,
          name: config.name,
        },
        uploaded,
        assemblyTemplateFileId: responses.assemblyTemplate?.DocumentJSONPathAssemblyTemplate?.FileId || '',
      };
      writeJSON(bundle.files.manifest, bundle.manifest);
    }

    const response = {
      ok: true,
      dryRun,
      package: bundle.manifest.package.shortName,
      version: bundle.manifest.version.shortName,
      bundlePath: bundle.bundlePath,
      configId: {
        input: config.input,
        resolved: config.resolved,
        shortName: config.shortName,
        name: config.name,
      },
      changes,
      uploadPlan,
      uploaded,
    };

    if (opts.json) {
      writeJson(response);
    } else if (!changes.versionMaster && !changes.assemblyTemplate) {
      log(opts, 'No package bundle changes detected.');
    } else if (dryRun) {
      log(opts, 'Dry run complete. No changes uploaded.');
    } else {
      log(opts, `Saved package ${response.package} ${response.version} to ConfigId ${config.resolved}.`);
    }
  });
}
