/** Deterministic, read-only resource comparison. No templateCompare dependency. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { JSDOM } from 'jsdom';
import { collectReferenceNames, explainRecordChanges, explainArtifacts, explainMetadata } from './resourceCompareContext.js';

export const REPORT_SCHEMA = 'occs-resource-comparison/v1';
const administrative = /^(ConfigId|CreatedBy|CreatedDtTm|Updated|UpdatedBy|UpdatedDtTm|LastUpdatedBy|LastUpdatedDtTm|Status|ConfigIdShortName|ConfigIdStatus)$/;
const transport = /^(links|Links|totalResults|TotalResults|hasMore|HasMore|layers|Layers|offset|Offset|limit|Limit)$/;
const blobDescriptor = new Set(['ContentData', 'FontImportedContent', 'DocumentJSONPathAssemblyTemplate']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function normalizeRecord(record, ownerIds = []) {
  const metadata = {};
  const owners = new Set(ownerIds.filter(Boolean));
  const position = node => {
    if (!object(node)) return null;
    for (const [key, value] of Object.entries(node)) {
      if (/RelInfo$/.test(key) && object(value)) {
        const entry = Object.entries(value).find(([key]) => /RelIndex$/.test(key));
        if (entry && entry[1] !== null && entry[1] !== '' && Number.isFinite(Number(entry[1]))) return Number(entry[1]);
      }
      if (/RelRec$/.test(key)) { const found = position(value); if (found !== null) return found; }
    }
    return null;
  };
  function clean(value, location = '$', parent = '') {
    if (Array.isArray(value)) {
      let ordered = value;
      if (value.length && value.every(item => position(item) !== null)) ordered = [...value].sort((a, b) => position(a) - position(b));
      else if (value.length && value.every(item => object(item) && item.StyleAttributeName)) ordered = [...value].sort((a, b) => a.StyleAttributeName.localeCompare(b.StyleAttributeName));
      return ordered.map((entry, i) => clean(entry, `${location}[${i}]`, parent));
    }
    if (!object(value)) return value;
    // OCCS collections may use either an array or an Items wrapper.
    if (Array.isArray(value.Items) && Object.keys(value).every(k => k === 'Items' || transport.test(k))) {
      return clean(value.Items, location, parent);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if ((blobDescriptor.has(parent) && ['Location', 'FileId'].includes(key)) || transport.test(key) || /RelUuid$/.test(key) || (/Uuid$/.test(key) && owners.has(child))) continue;
      if (administrative.test(key) || (['ShortName', 'Desc'].includes(key) && /VersionConfigInfo$/.test(parent))) {
        if (key === 'Status') {
          const statuses = Array.isArray(child) ? child : Array.isArray(child?.Items) ? child.Items : child ? [child] : [];
          metadata[`${location}.${key}`] = statuses.map(item => typeof item === 'string' ? { StatusCode: item } :
            { StatusCode: item.StatusCode || item.Code || 'Unknown', ...(item.EffDtTm ? { EffDtTm: item.EffDtTm } : {}) })
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        } else metadata[`${location}.${key}`] = child;
        continue;
      }
      result[key] = clean(child, `${location}.${key}`, key);
    }
    return result;
  }
  return { functional: clean(record), metadata };
}

function identity(value) {
  if (!object(value)) return null;
  for (const key of ['$$Id', 'ShortName', 'StyleAttributeName', 'Name']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  for (const [key, child] of Object.entries(value)) {
    if (object(child) && /(Rec|Info)$/.test(key)) {
      const found = identity(child);
      if (found) return found;
    }
  }
  const refs = Object.entries(value).filter(([key, val]) => /Uuid$/.test(key) && typeof val === 'string');
  return refs.length === 1 ? refs[0][1] : null;
}

export function diffValues(before, after, location = '$', changes = []) {
  if (same(before, after)) return changes;
  if (Array.isArray(before) && Array.isArray(after)) {
    const leftKeys = before.map(identity), rightKeys = after.map(identity);
    if ([...leftKeys, ...rightKeys].every(Boolean)
        && new Set(leftKeys).size === leftKeys.length && new Set(rightKeys).size === rightKeys.length) {
      if (!same(leftKeys.filter(k => rightKeys.includes(k)), rightKeys.filter(k => leftKeys.includes(k)))) {
        changes.push({ kind: 'reordered', path: `${location}.$order`, before: leftKeys, after: rightKeys });
      }
      const left = new Map(leftKeys.map((key, i) => [key, before[i]]));
      const right = new Map(rightKeys.map((key, i) => [key, after[i]]));
      for (const key of [...new Set([...leftKeys, ...rightKeys])].sort()) {
        diffValues(left.get(key), right.get(key), `${location}[${JSON.stringify(key)}]`, changes);
      }
    } else {
      // Preserve duplicate placements and unnamed collection order without
      // collapsing records into a name-keyed map.
      for (let i = 0; i < Math.max(before.length, after.length); i++) diffValues(before[i], after[i], `${location}[${i}]`, changes);
    }
    return changes;
  }
  if (object(before) && object(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      diffValues(before[key], after[key], `${location}.${key}`, changes);
    }
    return changes;
  }
  changes.push({ kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed', path: location,
    ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  return changes;
}

function artifactValue(artifact) {
  const bytes = Buffer.from(artifact.bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let text;
  if (artifact.text) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n'); }
    catch { /* Binary or non-UTF-8 artifacts still receive a complete byte comparison. */ }
  }
  if (artifact.json && text !== undefined) {
    try { return { json: JSON.parse(text) }; } catch { /* Report exact bytes when invalid JSON was exported. */ }
  }
  if (text !== undefined && artifact.html) {
    const dom = new JSDOM(text);
    try {
      const document = dom.window.document;
      const elements = tag => [...document.querySelectorAll(tag)].map(element => element.outerHTML);
      return { markup: text, textAndPayloads: document.body.textContent,
        fieldBindings: elements('comms-data'), conditions: elements('comms-cond'),
        loops: elements('comms-loop'), transforms: elements('comms-transform') };
    } finally { dom.window.close(); }
  }
  return text !== undefined ? { text } : { bytes: bytes.length, sha256: hash };
}

function sourceDetails(snapshot) {
  return { type: snapshot.type, name: snapshot.name, version: snapshot.version || null,
    source: snapshot.source, capturedAt: snapshot.capturedAt || null };
}

export function compareSnapshots(before, after) {
  if (before.type !== after.type || before.name.toLowerCase() !== after.name.toLowerCase()) {
    throw new Error('Both sides must identify the same resource type and short name.');
  }
  const a = normalizeRecord(before.record, before.ownerIds), b = normalizeRecord(after.record, after.ownerIds);
  const comparableRecords = before.detailsComplete !== false && after.detailsComplete !== false;
  const changes = comparableRecords ? diffValues(a.functional, b.functional) : [];
  const metadataChanges = [];
  for (const key of comparableRecords ? [...new Set([...Object.keys(a.metadata), ...Object.keys(b.metadata)])].sort() : []) {
    if (key.endsWith('.Status') && !same(a.metadata[key], b.metadata[key])) {
      metadataChanges.push({ kind: a.metadata[key] === undefined ? 'added' : b.metadata[key] === undefined ? 'removed' : 'changed',
        path: key, before: a.metadata[key], after: b.metadata[key] });
    } else diffValues(a.metadata[key], b.metadata[key], key, metadataChanges);
  }
  const left = new Map((before.artifacts || []).map(item => [item.label, item]));
  const right = new Map((after.artifacts || []).map(item => [item.label, item]));
  for (const label of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    // Unreadable evidence is not proof that an artifact was added or removed.
    if ((before.missingArtifacts || []).includes(label) || (after.missingArtifacts || []).includes(label)
        || (!left.has(label) && before.issues?.length) || (!right.has(label) && after.issues?.length)) continue;
    const l = left.has(label) ? artifactValue(left.get(label)) : undefined;
    const r = right.has(label) ? artifactValue(right.get(label)) : undefined;
    diffValues(l, r, `Artifacts[${JSON.stringify(label)}]`, changes);
  }
  const issues = [...(before.issues || []).map(message => `Before: ${message}`), ...(after.issues || []).map(message => `After: ${message}`)];
  const summary = Object.fromEntries(['added', 'removed', 'changed', 'reordered'].map(kind => [kind, changes.filter(c => c.kind === kind).length]));
  const names = { ...collectReferenceNames(before.record).names, ...collectReferenceNames(after.record).names,
    ...(before.referenceNames || {}), ...(after.referenceNames || {}) };
  const root = { type: before.type, name: before.name };
  const categories = ['Text', 'Fields', 'Rules and data', 'Order and placement', 'Styles and formatting', 'Files', 'Resource settings'];
  const insights = [...explainRecordChanges(changes, a.functional, b.functional, root, identity, names), ...explainArtifacts(before, after, names)]
    .sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category));
  const metadataInsights = explainMetadata(metadataChanges, a.functional, b.functional, root, identity, names);
  const contextWarnings = [...new Set([...(before.contextWarnings || []), ...(after.contextWarnings || [])])];
  return { schemaVersion: REPORT_SCHEMA, resource: { type: before.type, name: before.name },
    before: sourceDetails(before), after: sourceDetails(after), complete: issues.length === 0,
    result: issues.length ? 'incomplete' : changes.length ? 'different' : 'equivalent',
    summary, changes, metadataChanges, issues, insights, metadataInsights, contextWarnings,
    scope: 'Selected resource properties, direct relationships and its own exported artifacts. Referenced resources are compared as associations; their definitions are not recursively compared.',
    normalization: 'Object key order, collection Items wrappers and CRLF line endings are normalized. Owner/relationship UUIDs, Config IDs, transport locations and audit timestamps are excluded from functional changes. Authored whitespace is preserved.' };
}

const escape = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]#|])/g, '\\$1').replace(/\r?\n/g, ' ');
function block(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map(s => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text ?? '(absent)'}\n${fence}`;
}

export function renderComparisonMarkdown(report, { includeTechnical = false } = {}) {
  // Escape each line separately to retain useful line breaks within cells.
  const tableValue = value => String(value ?? '').split(/\r?\n/).map(escape).join('<br>');
  const insights = report.insights || [];
  const lines = ['# Resource comparison', '', `**Resource:** ${escape(report.resource.type)} / ${escape(report.resource.name)}`, '',
    '| Side | Version / snapshot | Source |', '| --- | --- | --- |',
    `| Before | ${escape(report.before.version || 'Snapshot')} | ${escape(report.before.source)} |`,
    `| After | ${escape(report.after.version || 'Snapshot')} | ${escape(report.after.source)} |`, '',
    '## Summary', '', `**Result: ${report.result.toUpperCase()}**`, '',
    report.result === 'equivalent' ? 'No functional differences found in the compared scope.' :
      report.result === 'incomplete' ? 'The comparison is incomplete. Missing evidence cannot establish equivalence; the findings below describe only the available information.' :
      `${insights.length} contextual change${insights.length === 1 ? '' : 's'} found.`, ''];
  for (const entry of insights) lines.push(`- **${escape(entry.title)}** — ${escape(entry.where)}`);
  lines.push('', '## Detailed changes', '');
  const details = entries => {
    for (const category of [...new Set(entries.map(entry => entry.category))]) {
      lines.push(`### ${escape(category)}`, '');
      for (const entry of entries.filter(entry => entry.category === category)) {
        lines.push(`#### ${escape(entry.title)}`, '', `**Where:** ${escape(entry.where)}`, '',
          '| Before | After |', '| --- | --- |', `| ${tableValue(entry.before)} | ${tableValue(entry.after)} |`, '');
        if (entry.note) lines.push(escape(entry.note), '');
      }
    }
  };
  details(insights);
  if (!insights.length) lines.push(report.changes.length ? 'Only low-level differences were detected. Exact evidence is available in JSON or with --include-technical.' : 'No functional changes detected in the available evidence.', '');
  lines.push('## Metadata changes', '');
  details(report.metadataInsights || []);
  if (!report.metadataInsights?.length) lines.push('No changes to the displayed version description or lifecycle information. Administrative identifiers and audit records are omitted from this view.', '');
  const issueText = issue => String(issue).replace(/(Artifact [^:]+ unavailable|Version details unavailable|Assembly Template unavailable):[\s\S]*/, '$1. Refresh the resource or check access; detailed errors are retained in JSON.');
  lines.push('## Completeness and scope', '', ...report.issues.map(issue => `- ${escape(issueText(issue))}`),
    ...(report.contextWarnings || []).map(issue => `- ${escape(issue)}`), '', report.scope, '', report.normalization, '',
    '## Comparison details', '', `Report schema: ${report.schemaVersion}`, '',
    `Before captured: ${escape(report.before.capturedAt || 'Not recorded in cache')}`, '',
    `After captured: ${escape(report.after.capturedAt || 'Not recorded in cache')}`, '');
  if (includeTechnical) {
    lines.push('## Technical evidence', '', 'Exact paths and values are retained here for troubleshooting.', '');
    for (const [heading, entries] of [['Functional evidence', report.changes], ['Administrative evidence', report.metadataChanges]]) {
      lines.push(`### ${heading}`, '');
      for (const entry of entries) lines.push(`#### ${escape(entry.kind)}: ${escape(entry.path)}`, '', '**Before**', '', block(entry.before), '', '**After**', '', block(entry.after), '');
    }
  }
  return lines.join('\n');
}
