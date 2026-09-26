import { loadSession } from './session.js';
import { deleteJson, get, mutateJson } from './api.js';
import { findArtifactByShortName } from './artifactLookup.js';
import { resolveOpenConfigId } from './configs.js';
import { documentSummary } from './documents.js';
import { writeStdoutJSON } from './utils.js';

const DOCUMENT_API = '/api/CommunicationDocument/v1';

function options(cmd) {
  return typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : (cmd || {});
}

function selector(opts) {
  return { sessionName: opts.session, customer: opts.customer, region: opts.region ?? opts.environment, tenancy: opts.tenancy };
}

function items(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.Items)) return value.Items;
  return value ? [value] : [];
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function date(value) {
  const normalized = required(value, 'Effective date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error('Effective date must be YYYY-MM-DD.');
  return `${normalized}T00:00:00.000000Z`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function withConfig(record, configId) {
  return configId === undefined || configId === null
    ? { ...record }
    : { ...record, ConfigId: String(configId) };
}

function statuses(record, configId) {
  return items(record?.Status).map((entry) => withConfig(entry, configId));
}

function output(opts, value, lines) {
  if (opts.json) return writeStdoutJSON(value);
  console.log(lines.join('\n'));
}

function unwrapDocument(item) {
  return item?.CommunicationDocumentConfigRec || item || {};
}

async function resolveDocument(session, input, opts) {
  const wanted = required(input, 'Document short name');
  if (/^[a-f\d]{32}$/i.test(wanted)) return { uuid: wanted, shortName: wanted };
  const found = await findArtifactByShortName(
    session,
    `${DOCUMENT_API}/CommunicationDocumentConfigRec`,
    'CommunicationDocumentConfigInfo.ShortName',
    wanted,
    documentSummary,
    opts,
  );
  const record = unwrapDocument(found);
  const uuid = record.CommunicationDocumentConfigUuid;
  if (!uuid) throw new Error(`Document ${wanted} did not include a UUID.`);
  return { uuid, shortName: record.CommunicationDocumentConfigInfo?.ShortName || wanted };
}

function versionRecord(master, requestedVersion) {
  const versions = items(master?.CommunicationDocumentMasterVersions).map((entry) => entry?.CommunicationDocumentVersionConfigRec || entry || {});
  if (!versions.length) throw new Error('Document has no versions.');
  if (!requestedVersion) return versions[0];
  const wanted = String(requestedVersion).toLowerCase();
  const match = versions.filter((entry) => String(entry.CommunicationDocumentVersionConfigInfo?.ShortName || '').toLowerCase() === wanted);
  if (match.length !== 1) throw new Error(`Document version not found or ambiguous: ${requestedVersion}.`);
  return match[0];
}

function relationshipInfo(entry, name) {
  return entry?.[name]?.[`${name.replace('Rec', 'Info')}`] || {};
}

export function copyDocumentLayouts(sourceLayouts, versionUuid, configId) {
  return items(sourceLayouts).map((entry) => {
    const info = relationshipInfo(entry, 'CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec');
    if (!info.CommunicationLayoutConfigUuid) return null;
    return { CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec: {
      CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo: withConfig({
        CommunicationLayoutConfigUuid: info.CommunicationLayoutConfigUuid,
        LayoutRelIndex: info.LayoutRelIndex ?? 0,
        LayoutAlwaysTriggerInd: Boolean(info.LayoutAlwaysTriggerInd),
        LayoutPlacement: info.LayoutPlacement || '',
        CommunicationDocumentVersionConfigUuid: versionUuid,
      }, configId),
    } };
  }).filter(Boolean);
}

export function copyDocumentStyles(sourceStyles, versionUuid, configId) {
  return items(sourceStyles).map((entry) => {
    const info = relationshipInfo(entry, 'CommunicationDocumentVersionConfigCommunicationStyleConfigRelRec');
    if (!info.CommunicationStyleConfigUuid) return null;
    return { CommunicationDocumentVersionConfigCommunicationStyleConfigRelRec: {
      CommunicationDocumentVersionConfigCommunicationStyleConfigRelInfo: withConfig({
        CommunicationStyleConfigUuid: info.CommunicationStyleConfigUuid,
        StyleRelIndex: info.StyleRelIndex ?? 0,
        StyleClassName: info.StyleClassName || '',
        CommunicationDocumentVersionConfigUuid: versionUuid,
      }, configId),
    } };
  }).filter(Boolean);
}

function companyRelationships(sourceCompanies, documentUuid, configId, { includeRelationUuid = false } = {}) {
  return items(sourceCompanies).map((entry) => {
    const rec = entry?.CompanyCommunicationDocumentConfigRelRec || entry || {};
    const info = rec.CompanyCommunicationDocumentConfigRelInfo || {};
    if (!info.CompanyUuid) return null;
    return { CompanyCommunicationDocumentConfigRelRec: {
      CompanyCommunicationDocumentConfigRelInfo: withConfig({
        CommunicationDocumentConfigUuid: documentUuid,
        CompanyUuid: info.CompanyUuid,
        OrgCompanyRole: info.OrgCompanyRole || '',
      }, configId),
      ...(includeRelationUuid && rec.CompanyCommunicationDocumentConfigRelUuid
        ? { CompanyCommunicationDocumentConfigRelUuid: rec.CompanyCommunicationDocumentConfigRelUuid }
        : {}),
    } };
  }).filter(Boolean);
}

export function buildCreateDocumentPayload({ shortName, name = shortName, description = '', version = '1.0', versionDescription = '', renderingType = 'Document', packagePageCountExcludeInd = false, effectiveDate, companies }) {
  const doc = required(shortName, 'Document short name');
  const companyRows = companyRelationships(companies, 'DUMMY', undefined);
  if (!companyRows.length) throw new Error('At least one company association is required.');
  return {
    CommunicationDocumentConfigRec: {
      CommunicationDocumentConfigInfo: { Name: required(name, 'Document name'), ShortName: doc, Desc: String(description ?? '') },
      Status: [{ StatusCode: 'Active', EffDtTm: date(effectiveDate) }],
    },
    CommunicationDocumentVersionConfigRec: {
      CommunicationDocumentVersionConfigInfo: {
        ShortName: required(version, 'Version'), Desc: String(versionDescription ?? ''), RenderingType: required(renderingType, 'Rendering type'),
        CommunicationDocumentConfigUuid: 'DUMMY', PackagePageCountExcludeInd: Boolean(packagePageCountExcludeInd),
      },
      Status: [{ StatusCode: 'Active', EffDtTm: date(effectiveDate) }],
    },
    CommunicationDocumentVersionLayouts: [],
    CommunicationDocumentVersionStyles: [],
    CommunicationDocumentVersionRoles: [],
    CompanyCommunicationDocuments: companyRows,
  };
}

/** Convert a read/create response into the compact aggregate accepted by the PUT endpoint. */
export function buildDocumentVersionUpdatePayload({ master, configId, layouts, styles }) {
  const document = unwrapDocument(master?.CommunicationDocumentConfigRec || master);
  const version = master?.CommunicationDocumentVersionConfigRec || {};
  const documentUuid = document.CommunicationDocumentConfigUuid;
  const versionUuid = version.CommunicationDocumentVersionConfigUuid;
  if (!documentUuid || !versionUuid) throw new Error('Document update requires document and version UUIDs.');
  const documentInfo = document.CommunicationDocumentConfigInfo || {};
  const versionInfo = version.CommunicationDocumentVersionConfigInfo || {};
  return {
    CommunicationDocumentConfigRec: {
      CommunicationDocumentConfigInfo: withConfig(documentInfo, configId),
      Status: statuses(document, configId),
      CommunicationDocumentConfigUuid: documentUuid,
    },
    CommunicationDocumentVersionConfigRec: {
      CommunicationDocumentVersionConfigInfo: withConfig({ ...versionInfo, CommunicationDocumentConfigUuid: documentUuid }, configId),
      Status: statuses(version, configId),
      CommunicationDocumentVersionConfigUuid: versionUuid,
    },
    CommunicationDocumentVersionLayouts: layouts === undefined ? copyDocumentLayouts(master?.CommunicationDocumentVersionLayouts, versionUuid, configId) : layouts,
    CommunicationDocumentVersionStyles: styles === undefined ? copyDocumentStyles(master?.CommunicationDocumentVersionStyles, versionUuid, configId) : styles,
    CommunicationDocumentVersionRoles: [],
    CompanyCommunicationDocuments: companyRelationships(master?.CompanyCommunicationDocuments, documentUuid, configId, { includeRelationUuid: true }),
  };
}

function createdIds(created) {
  const documentUuid = created?.CommunicationDocumentConfigRec?.CommunicationDocumentConfigUuid;
  const versionUuid = created?.CommunicationDocumentVersionConfigRec?.CommunicationDocumentVersionConfigUuid;
  if (!documentUuid || !versionUuid) throw new Error('OCCS create response did not include document and version UUIDs.');
  return { documentUuid, versionUuid };
}

async function create(session, payload, configId, opts) {
  return mutateJson(session, 'POST', `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig`, payload, {
    headers: { transactionconfigid: String(configId) }, verbose: opts.verbose, timeout: opts.timeout,
  });
}

async function putVersion(session, versionUuid, payload, configId, opts) {
  return mutateJson(session, 'PUT', `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig/${versionUuid}`, payload, {
    headers: { transactionconfigid: String(configId) }, verbose: opts.verbose, timeout: opts.timeout,
  });
}

export async function documentCreateCommand(shortName, cmd) {
  const opts = options(cmd);
  const session = loadSession(selector(opts));
  const config = await resolveOpenConfigId(session, required(opts.configId, 'Config ID'), opts);
  const companies = [{ CompanyCommunicationDocumentConfigRelRec: { CompanyCommunicationDocumentConfigRelInfo: { CompanyUuid: required(opts.companyUuid, 'Company UUID'), OrgCompanyRole: opts.companyRole || 'Marketing' } } }];
  const payload = buildCreateDocumentPayload({ shortName, name: opts.name || shortName, description: opts.desc || '', version: opts.version || '1.0', versionDescription: opts.versionDesc || '', renderingType: opts.renderingType || 'Document', packagePageCountExcludeInd: Boolean(opts.excludePackagePageCount), effectiveDate: opts.effectiveDate || today(), companies });
  if (opts.dryRun) return output(opts, { ok: true, dryRun: true, operation: 'create-document', configId: config, payload }, ['Dry run: no OCCS changes made.']);
  const created = await create(session, payload, config.resolved, opts);
  const ids = createdIds(created);
  await get(session, `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig/${ids.versionUuid}`, { depth: true, limit: 20 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  output(opts, { ok: true, operation: 'create-document', configId: config, ...ids }, [`Created document ${shortName} v${opts.version || '1.0'}.`, `Document UUID: ${ids.documentUuid}`, `Version UUID: ${ids.versionUuid}`]);
}

export async function documentDuplicateCommand(sourceInput, targetShortName, cmd) {
  const opts = options(cmd);
  const session = loadSession(selector(opts));
  const config = await resolveOpenConfigId(session, required(opts.configId, 'Config ID'), opts);
  const source = await resolveDocument(session, sourceInput, opts);
  const documentMaster = await get(session, `${DOCUMENT_API}/CommunicationDocumentMasterConfig/${source.uuid}`, { depth: true, limit: 40 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  const sourceVersion = versionRecord(documentMaster, opts.fromVersion);
  const sourceVersionUuid = sourceVersion.CommunicationDocumentVersionConfigUuid;
  const sourceMaster = await get(session, `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig/${sourceVersionUuid}`, { depth: true, limit: 80 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  const sourceInfo = documentMaster.CommunicationDocumentConfigRec?.CommunicationDocumentConfigInfo || {};
  const versionInfo = sourceMaster.CommunicationDocumentVersionConfigRec?.CommunicationDocumentVersionConfigInfo || {};
  const companies = sourceMaster.CompanyCommunicationDocuments || documentMaster.CompanyCommunicationDocuments || [];
  const payload = buildCreateDocumentPayload({ shortName: targetShortName, name: opts.name || targetShortName, description: opts.desc ?? sourceInfo.Desc ?? '', version: opts.version || versionInfo.ShortName || '1.0', versionDescription: opts.versionDesc ?? versionInfo.Desc ?? '', renderingType: versionInfo.RenderingType || 'Document', packagePageCountExcludeInd: Boolean(versionInfo.PackagePageCountExcludeInd), effectiveDate: opts.effectiveDate || today(), companies });
  if (opts.dryRun) return output(opts, { ok: true, dryRun: true, operation: 'duplicate-document', configId: config, source, payload, layouts: items(sourceMaster.CommunicationDocumentVersionLayouts).length, styles: items(sourceMaster.CommunicationDocumentVersionStyles).length }, ['Dry run: no OCCS changes made.']);
  const created = await create(session, payload, config.resolved, opts);
  const ids = createdIds(created);
  const update = buildDocumentVersionUpdatePayload({
    master: created,
    configId: config.resolved,
    layouts: copyDocumentLayouts(sourceMaster.CommunicationDocumentVersionLayouts, ids.versionUuid, config.resolved),
    styles: copyDocumentStyles(sourceMaster.CommunicationDocumentVersionStyles, ids.versionUuid, config.resolved),
  });
  await putVersion(session, ids.versionUuid, update, config.resolved, opts);
  const verified = await get(session, `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig/${ids.versionUuid}`, { depth: true, limit: 80 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  const verifiedLayouts = items(verified?.CommunicationDocumentVersionLayouts).length;
  const verifiedStyles = items(verified?.CommunicationDocumentVersionStyles).length;
  output(opts, { ok: true, operation: 'duplicate-document', configId: config, source, ...ids, copiedLayouts: update.CommunicationDocumentVersionLayouts.length, copiedStyles: update.CommunicationDocumentVersionStyles.length, verifiedLayouts, verifiedStyles }, [`Duplicated ${source.shortName} as ${targetShortName}.`, `Copied ${verifiedLayouts} layout(s) and ${verifiedStyles} style(s).`]);
}

export async function documentDeleteCommand(input, cmd) {
  const opts = options(cmd);
  if (!opts.yes) throw new Error('Document deletion requires --yes.');
  const session = loadSession(selector(opts));
  const config = await resolveOpenConfigId(session, required(opts.configId, 'Config ID'), opts);
  const document = await resolveDocument(session, input, opts);
  const documentMaster = await get(session, `${DOCUMENT_API}/CommunicationDocumentMasterConfig/${document.uuid}`, { depth: true, limit: 80 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
  const versions = items(documentMaster.CommunicationDocumentMasterVersions).map((entry) => entry?.CommunicationDocumentVersionConfigRec || entry || {}).filter((entry) => entry.CommunicationDocumentVersionConfigUuid);
  if (opts.dryRun) return output(opts, { ok: true, dryRun: true, operation: 'delete-document', configId: config, document, versionCount: versions.length, detachAssociations: Boolean(opts.detachAssociations) }, ['Dry run: no OCCS changes made.']);
  if (versions.length && !opts.detachAssociations) throw new Error('Document has version associations. Re-run with --detach-associations to remove them before deletion.');
  for (const version of versions) {
    const versionMaster = await get(session, `${DOCUMENT_API}/CommunicationDocumentVersionMasterConfig/${version.CommunicationDocumentVersionConfigUuid}`, { depth: true, limit: 80 }, opts.verbose, { timeout: opts.timeout, throwOnError: true });
    const update = buildDocumentVersionUpdatePayload({ master: versionMaster, configId: config.resolved, layouts: [], styles: [] });
    await putVersion(session, version.CommunicationDocumentVersionConfigUuid, update, config.resolved, opts);
  }
  await deleteJson(session, `${DOCUMENT_API}/CommunicationDocumentMasterConfig/${document.uuid}`, { headers: { transactionconfigid: String(config.resolved) }, verbose: opts.verbose, timeout: opts.timeout });
  output(opts, { ok: true, operation: 'delete-document', configId: config, document, detachedVersions: versions.length }, [`Deleted document ${document.shortName}.`]);
}
