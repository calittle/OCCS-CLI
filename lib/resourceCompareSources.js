/** Resource readers and CLI contract for resourceCompare. All remote calls are reads. */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { loadSession } from './session.js';
import { resolveRequestTimeoutMs } from './requestTimeout.js';
import { get, retryTransientRequest, retryUnauthorizedRequest } from './api.js';
import { findArtifactByShortName } from './artifactLookup.js';
import { safePathSegment } from './utils.js';
import { collectReferenceNames } from './resourceCompareContext.js';
import { compareSnapshots, renderComparisonMarkdown } from './resourceCompare.js';

export const RESOURCE_SPECS = Object.fromEntries([
  ['content', 'CommunicationContent', 'CommunicationContent', 'CommunicationContentMasterVersions'],
  ['document', 'CommunicationDocument', 'CommunicationDocument', 'CommunicationDocumentMasterVersions'],
  ['package', 'CommunicationPackage', 'CommunicationPackage', 'CommunicationPackageMasterVersions'],
  ['chart', 'Chart', 'Chart', 'ChartVersions'],
  ['layout', 'CommunicationDocument', 'CommunicationLayout', null],
  ['style', 'CommunicationDocument', 'CommunicationStyle', null],
  ['font', 'CommunicationDocument', 'CommunicationFont', null],
].map(([type, api, prefix, versions]) => [type, { type, api, prefix, versions, folder: `${type}s` }]));
const items = value => Array.isArray(value) ? value : Array.isArray(value?.Items) ? value.Items : [];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function resourceSpec(type) {
  const spec = RESOURCE_SPECS[String(type).toLowerCase()];
  if (!spec) throw new Error(`Unsupported resource type: ${type}. Choose ${Object.keys(RESOURCE_SPECS).join(', ')}.`);
  return spec;
}
function within(root, ...segments) {
  const base = path.resolve(root), target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('Resource path escapes the selected cache.');
  return target;
}
function cacheFolder(cache, spec, name) {
  const root = path.resolve(cache, spec.folder);
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  const encoded = safePathSegment(name).toLowerCase();
  const matches = entries.filter(entry => entry.name.toLowerCase() === encoded);
  if (matches.length !== 1) throw new Error(`Expected one cached ${spec.type} named ${name}; found ${matches.length} in ${root}.`);
  return within(root, matches[0].name);
}
function oneFile(folder, predicate) {
  const files = fs.readdirSync(folder).filter(predicate);
  if (files.length !== 1) throw new Error(`Expected one resource record in ${folder}; found ${files.length}.`);
  return within(folder, files[0]);
}
function versionRows(master, spec) {
  return items(master[spec.versions]).map(row => row[`${spec.prefix}VersionConfigRec`] || row).map(rec => {
    const info = rec[`${spec.prefix}VersionConfigInfo`] || {};
    return { shortName: String(info.ShortName || ''), uuid: rec[`${spec.prefix}VersionConfigUuid`] || '',
      description: String(info.Desc || ''), status: items(rec.Status), record: rec };
  }).filter(row => row.shortName).sort((a, b) => a.shortName.localeCompare(b.shortName, 'en', { numeric: true }));
}
function chooseVersion(master, spec, requested) {
  const rows = versionRows(master, spec);
  const matches = rows.filter(row => row.shortName.toLowerCase() === String(requested || '').toLowerCase());
  if (matches.length !== 1) throw new Error(`Version ${requested || '(not specified)'} is ${matches.length ? 'ambiguous' : 'not available'}. Available versions: ${rows.map(row => row.shortName).join(', ') || '(none)'}.`);
  return matches[0];
}

export class ResourceReader {
  constructor(type, name, { cache, session, timeout, verbose = false, apiGet = get, lookup = findArtifactByShortName, binaryGet } = {}) {
    this.spec = resourceSpec(type);
    this.name = String(name || '').trim();
    if (!this.name) throw new Error('A resource short name is required.');
    Object.assign(this, { cache, session, timeout, verbose, apiGet, lookup, binaryGet });
  }
  async json(endpoint) {
    const value = await this.apiGet(this.session, endpoint, { depth: true }, this.verbose, { timeout: this.timeout, throwOnError: true });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid resource response at ${endpoint}`);
    return value;
  }
  async open() {
    const spec = this.spec, prefix = spec.prefix;
    if (this.cache) {
      this.directory = cacheFolder(this.cache, spec, this.name);
      const file = spec.versions ? oneFile(this.directory, name => name.endsWith('_master.json'))
        : oneFile(this.directory, name => name.endsWith('.json') && name !== 'document.json');
      this.master = read(file);
      this.source = path.resolve(this.cache);
    } else {
      const index = await this.lookup(this.session, `/api/${spec.api}/v1/${prefix}ConfigRec`, `${prefix}ConfigInfo.ShortName`, this.name,
        item => { const rec = item[`${prefix}ConfigRec`] || item; return { shortName: rec[`${prefix}ConfigInfo`]?.ShortName }; },
        { timeout: this.timeout, verbose: this.verbose });
      const rec = index[`${prefix}ConfigRec`] || index;
      const uuid = rec[`${prefix}ConfigUuid`];
      if (!uuid) throw new Error(`Missing resource UUID for ${this.name}.`);
      this.master = ['style', 'font'].includes(spec.type) ? { [`${prefix}ConfigRec`]: rec }
        : await this.json(`/api/${spec.api}/v1/${prefix}MasterConfig/${uuid}`);
      this.source = String(this.session.baseUrl || '').replace(/\/$/, '');
    }
    if (!this.master || typeof this.master !== 'object' || Array.isArray(this.master)) throw new Error('Invalid resource master record.');
    if (!spec.versions) {
      const own = this.master[`${prefix}ConfigRec`] || this.master;
      if (!own[`${prefix}ConfigInfo`]) throw new Error('Resource definition is missing its properties.');
    }
    return this;
  }
  versions() {
    return { ok: true, resource: { type: this.spec.type, name: this.name }, versioned: Boolean(this.spec.versions), source: this.source,
      versions: this.spec.versions ? versionRows(this.master, this.spec).map(({ record, ...row }) => row) : [] };
  }
  async binary(location) {
    let relative = String(location || '');
    if (/^(?:https?:)?\/\//i.test(relative)) throw new Error('Unexpected absolute artifact URL.');
    relative = relative.replace(/^\/?api\//, '').replace(/^\//, '');
    if (!relative.startsWith(`${this.spec.api}/v1/`)) relative = `${this.spec.api}/v1/${relative}`;
    if (decodeURIComponent(relative).replaceAll('\\', '/').split('/').some(part => ['..', '.'].includes(part))) throw new Error('Invalid artifact path.');
    const url = `${String(this.session.baseUrl).replace(/\/$/, '')}/api/${relative}`;
    if (this.binaryGet) return Buffer.from(await this.binaryGet(url));
    const response = await retryUnauthorizedRequest(this.session, () => retryTransientRequest(() => axios.get(url, {
      headers: { Authorization: `Bearer ${this.session.token}` }, responseType: 'arraybuffer', timeout: this.timeout,
    }), { url: relative }), { url: relative, timeout: this.timeout });
    return Buffer.from(response.data);
  }
  async resolveReferenceNames(record, ownerIds) {
    const { names, refs } = collectReferenceNames(this.master);
    collectReferenceNames(record, names, refs);
    const wanted = Object.entries(refs).filter(([id]) => !names[id] && !ownerIds.includes(id));
    if (this.cache) {
      // Read resource metadata only. Never fetch anything while comparing caches.
      for (const type of new Set(wanted.map(([, type]) => type))) {
        const spec = RESOURCE_SPECS[type];
        if (!spec) continue;
        const root = path.join(this.cache, spec.folder);
        if (!fs.existsSync(root)) continue;
        for (const folder of fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory())) {
          const directory = path.join(root, folder.name);
          for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
            try {
              const fallback = collectReferenceNames(read(path.join(directory, file))).names;
              for (const [id, value] of Object.entries(fallback)) if (!names[id]) names[id] = value;
            }
            catch { /* Missing labels do not invalidate resource comparison evidence. */ }
          }
        }
      }
    } else {
      let next = 0;
      const load = async () => {
        while (next < wanted.length) {
          const [id, type] = wanted[next++];
          const spec = RESOURCE_SPECS[type];
          if (!spec) continue;
          try {
            const metadata = await this.json(`/api/${spec.api}/v1/${spec.prefix}ConfigRec/${encodeURIComponent(id)}`);
            const fallback = collectReferenceNames(metadata).names;
            for (const [id, value] of Object.entries(fallback)) if (!names[id]) names[id] = value;
          } catch { /* Retain the reference change, explaining that its name is unavailable. */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, load));
    }
    const missing = wanted.filter(([id]) => !names[id]);
    return { referenceNames: names, contextWarnings: missing.length ? [
      `Names could not be resolved for ${missing.length} referenced resource${missing.length === 1 ? '' : 's'}. Changes are described by resource type; exact identifiers remain in JSON or the optional technical appendix.`
    ] : [] };
  }
  async snapshot(requested) {
    const { spec, master } = this, prefix = spec.prefix;
    const version = spec.versions ? chooseVersion(master, spec, requested) : null;
    if (!spec.versions && requested) throw new Error(`${spec.type} has no explicit versions. Compare two cache snapshots instead.`);
    let record = master, versionDir = this.directory, issues = [], artifacts = [], missingArtifacts = [], detailsComplete = true;
    const attempt = async (label, action) => {
      try { return await action(); }
      catch (error) { issues.push(`${label}: ${error.message}`); return null; }
    };
    if (version) {
      if (this.cache) {
        const segment = safePathSegment(version.shortName);
        versionDir = within(this.directory, 'versions', segment);
        let file = spec.type === 'document' ? within(this.directory, 'versions', `${segment}.json`)
          : within(versionDir, spec.type === 'content' ? `${segment}_expanded.json` : `${segment}.json`);
        if (spec.type === 'package') {
          const expanded = within(versionDir, `${segment}_expanded.json`);
          if (fs.existsSync(expanded)) file = expanded;
          else { detailsComplete = false; issues.push('Cached package version lacks expanded document associations. Use live comparison or refresh with a CLI that exports expanded package versions.'); }
        }
        // An expanded content record is required to compare style associations.
        record = await attempt('Version details unavailable', () => read(file));
        if (record === null) { record = version.record; detailsComplete = false; }
      } else {
        if (!version.uuid) throw new Error(`Version ${requested} has no UUID.`);
        record = await attempt('Version details unavailable', () => this.json(`/api/${spec.api}/v1/${prefix}VersionMasterConfig/${version.uuid}`));
        if (record === null) { record = version.record; detailsComplete = false; }
      }
    }
    const rec = record[`${prefix}VersionConfigRec`] || record[`${prefix}ConfigRec`] || record;
    const info = rec[`${prefix}${version ? 'Version' : ''}ConfigInfo`] || {};
    if (version && String(info.ShortName || '').toLowerCase() !== version.shortName.toLowerCase()) {
      detailsComplete = false;
      issues.push('The version details are missing or identify a different version; the selected version could not be fully verified.');
    }
    const addFile = async (label, descriptor, file, { text = false, json = false, html = false } = {}) => {
      if (!descriptor || typeof descriptor !== 'object') return;
      const bytes = await attempt(`Artifact ${label} unavailable`, async () => {
        if (!this.cache && !descriptor.Location) throw new Error('Missing artifact location.');
        return this.cache ? fs.readFileSync(file) : this.binary(descriptor.Location);
      });
      if (bytes !== null) artifacts.push({ label, bytes, text, json, html });
      else missingArtifacts.push(label);
    };
    if (spec.type === 'content') {
      const contentInfo = master.CommunicationContentConfigRec?.CommunicationContentConfigInfo || {};
      const contentType = String(contentInfo.ContentType || info.ContentType || '').toLowerCase();
      const image = contentType === 'image';
      const requiresBody = ['', 'text', 'html', 'image'].includes(contentType);
      let data = items(info.CommunicationContentVersionConfigData);
      // Master version data can contain blob descriptors omitted by expansion.
      if (!data.length) data = items(version?.record?.CommunicationContentVersionConfigInfo?.CommunicationContentVersionConfigData);
      if (!data.length && requiresBody) issues.push('Content data descriptors unavailable; the content body could not be verified.');
      for (const [i, item] of data.entries()) {
        if (!item.ContentData?.Location && !item.ContentData?.FileId) {
          if (requiresBody) issues.push(`Content data ${i + 1} has no body descriptor.`);
          continue;
        }
        await addFile(`Content body ${i + 1}`, item.ContentData,
          this.cache && within(versionDir, `${safePathSegment(item.ContentData.FileId)}.blob`), { text: !image, html: !image });
      }
    }
    if (spec.type === 'font') {
      const descriptor = info.FontImportedContent;
      if (!descriptor?.Location && !descriptor?.FileName) issues.push('Font file descriptor unavailable.');
      else await addFile('Font file', descriptor, this.cache && within(this.directory, safePathSegment(descriptor.FileName)));
    }
    if (spec.type === 'package') {
      // The exported version record may omit AT metadata. Try the AT in all
      // cases and flag absence as incomplete instead of declaring equivalence.
      const at = await attempt('Assembly Template unavailable', async () => this.cache
        ? read(within(versionDir, 'AssemblyTemplate.json'))
        : this.json(`/api/${spec.api}/v1/${prefix}VersionConfigRec/${version.uuid}/${prefix}VersionConfigInfo/DocumentJSONPathAssemblyTemplate`));
      if (at !== null) record = { ...record, AssemblyTemplate: at };
    }
    const owner = master[`${prefix}ConfigRec`] || master;
    const ownerIds = [owner[`${prefix}ConfigUuid`], version?.uuid];
    const context = await this.resolveReferenceNames(record, ownerIds);
    return { ...context, type: spec.type, name: this.name, version: version?.shortName || null, source: this.source,
      capturedAt: this.cache ? null : new Date().toISOString(), record, artifacts, missingArtifacts, detailsComplete, issues,
      ownerIds };
  }
}

export async function compareCommand(type, name, command) {
  const opts = command.optsWithGlobals ? command.optsWithGlobals() : command;
  try {
    const spec = resourceSpec(type);
    const format = opts.json ? 'json' : opts.format || 'md';
    if (!['json', 'md'].includes(format)) throw new Error('Format must be md or json.');
    if (opts.cache && (opts.fromCache || opts.toCache)) throw new Error('Use --cache or --from-cache/--to-cache, not both.');
    if (Boolean(opts.fromCache) !== Boolean(opts.toCache)) throw new Error('Provide both --from-cache and --to-cache.');
    const offline = Boolean(opts.cache || opts.fromCache);
    if (!spec.versions && !offline && !opts.listVersions) throw new Error(`${type} has no explicit versions. Use --from-cache and --to-cache.`);
    if (!opts.listVersions && !spec.versions && !opts.fromCache) throw new Error('Unversioned resources require --from-cache and --to-cache.');
    if (!opts.listVersions && spec.versions && (!opts.fromVersion || !opts.toVersion)) throw new Error('Provide --from-version and --to-version.');
    if (!spec.versions && (opts.fromVersion || opts.toVersion)) throw new Error(`${type} has no explicit versions. Compare cache snapshots without version options.`);
    const session = offline ? null : loadSession({ sessionName: opts.session });
    const reader = cache => new ResourceReader(type, name, { cache, session, timeout: resolveRequestTimeoutMs(opts.timeout), verbose: format !== 'json' && opts.verbose });
    const a = await reader(opts.cache || opts.fromCache).open();
    let result;
    if (opts.listVersions) result = a.versions();
    else {
      const b = offline && opts.fromCache ? await reader(opts.toCache).open() : a;
      const report = compareSnapshots(await a.snapshot(opts.fromVersion), await b.snapshot(opts.toVersion));
      result = { ok: true, report, markdown: renderComparisonMarkdown(report, { includeTechnical: Boolean(opts.includeTechnical) }) };
    }
    const output = format === 'json' ? JSON.stringify(result, null, 2) + '\n' : result.markdown || JSON.stringify(result, null, 2) + '\n';
    if (opts.output) fs.writeFileSync(path.resolve(opts.output), output, 'utf8');
    process.stdout.write(output);
    if (result.report && !result.report.complete) process.exitCode = 2;
  } catch (error) {
    process.exitCode = 1;
    if (opts.json || opts.format === 'json') process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
    else process.stderr.write(`Comparison failed: ${error.message}\n`);
  }
}
