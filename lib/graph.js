import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { ensureDir, safePathSegment } from './utils.js';

const sanitize = (str) => `"${str.replaceAll('"', '').replaceAll('\\', '\\\\')}"`;
const MAX_ORDER_INDEX = Number.MAX_SAFE_INTEGER;

function splitCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      cols.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  cols.push(current);
  return cols.map((value) => value.replace(/^"|"$/g, '').trim());
}

function parseDetails(detailsText) {
  const details = {};
  if (!detailsText) return details;

  for (const part of detailsText.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key) continue;
    details[key] = value;
  }

  return details;
}

function asIndex(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : MAX_ORDER_INDEX;
}

function extractVersionParts(versionId) {
  const raw = String(versionId || '').trim();
  if (!raw) return [];
  const normalized = raw.replace(/^v/i, '');
  const matches = normalized.match(/\d+/g);
  if (!matches) return [];
  return matches.map((n) => Number.parseInt(n, 10));
}

function compareVersionIds(a, b) {
  const aParts = extractVersionParts(a);
  const bParts = extractVersionParts(b);

  if (aParts.length > 0 || bParts.length > 0) {
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i += 1) {
      const av = aParts[i] ?? -1;
      const bv = bParts[i] ?? -1;
      if (av !== bv) return av - bv;
    }
  }

  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function pickLatestVersionId(versionIds) {
  if (!versionIds || versionIds.length === 0) return '';
  return [...versionIds].sort(compareVersionIds).at(-1);
}

export async function graphCommand(cmd) {
  console.log("(>'-')> Reticulating splines...\n");
  const baseDir = cmd.output || './output';
  const reportDir = path.join(baseDir, 'crossref');
  const csvPath = path.join(reportDir, 'crossref.csv');
  const graphDir = path.join(baseDir, 'graphs');
  ensureDir(graphDir);
  if (!fs.existsSync(csvPath)) {
    console.error(chalk.red(`❌ crossref.csv not found at ${csvPath}. Run crossrefCommand first.`));
    return;
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').trim().split('\n');
  const headers = splitCsvLine(lines.shift().replace(/^\uFEFF/, ''));

  const [rootIdx, sourceTypeIdx, sourceIdIdx, relationIdx, targetTypeIdx, targetIdIdx, detailsIdx] =
    ['RootDocument', 'SourceType', 'SourceId', 'Relation', 'TargetType', 'TargetId', 'Details']
      .map(h => headers.findIndex(col => col.trim() === h));  

  const records = lines.map((line) => {
    const cols = splitCsvLine(line);
    return {
      rootDoc: cols[rootIdx] || '',
      sourceType: cols[sourceTypeIdx] || '',
      sourceId: cols[sourceIdIdx] || '',
      relation: cols[relationIdx] || '',
      targetType: cols[targetTypeIdx] || '',
      targetId: cols[targetIdIdx] || '',
      details: parseDetails(cols[detailsIdx] || ''),
    };
  });

  const buildGraph = (doc, docRecords) => {
    const edges = new Set();
    const nodeMeta = new Map();
    const siblingGroups = new Map();
    const clusterGroups = new Map();
    const rows = [];

    const getNodeKey = (type, id) => `${type}: ${id}`;
    const setNodeDepth = (node, depthValue) => {
      if (!Number.isFinite(depthValue)) return;
      const existing = nodeMeta.get(node) || {};
      const depth = existing.depth;
      if (!Number.isFinite(depth) || depthValue < depth) {
        existing.depth = depthValue;
      }
      nodeMeta.set(node, existing);
    };

    const addNode = (node, type) => {
      const existing = nodeMeta.get(node) || {};
      existing.type = type;
      nodeMeta.set(node, existing);
    };

    const addSibling = (parent, child, index) => {
      if (!parent || !child) return;
      if (!siblingGroups.has(parent)) siblingGroups.set(parent, []);
      siblingGroups.get(parent).push({ child, index });
    };

    const addClusterNode = (clusterKey, node) => {
      if (!clusterKey || !node) return;
      if (!clusterGroups.has(clusterKey)) clusterGroups.set(clusterKey, new Set());
      clusterGroups.get(clusterKey).add(node);
    };

    const latestBySource = new Map();
    if (!cmd.allVersions) {
      for (const rec of docRecords) {
        if (rec.relation !== 'has-version') continue;
        const sourceKey = `${rec.sourceType}:${rec.sourceId}->${rec.targetType}`;
        if (!latestBySource.has(sourceKey)) latestBySource.set(sourceKey, []);
        latestBySource.get(sourceKey).push(rec.targetId);
      }
    }

    const latestEdgeSet = new Set();
    if (!cmd.allVersions) {
      for (const [sourceKey, targets] of latestBySource.entries()) {
        const latest = pickLatestVersionId(targets);
        if (latest) latestEdgeSet.add(`${sourceKey}:${latest}`);
      }
    }

    const resolveNodeRaw = (type, id, rec, role) => {
      if (type === 'DocumentVersion') {
        const docName =
          role === 'target'
            ? (rec.sourceType === 'Document' ? rec.sourceId : rec.rootDoc)
            : rec.rootDoc;
        return docName ? `${type}: ${docName}@${id}` : `${type}: ${id}`;
      }

      if (type === 'ContentVersion') {
        const contentName =
          role === 'target'
            ? (rec.sourceType === 'Content' ? rec.sourceId : rec.details?.content)
            : (rec.details?.content || rec.sourceId);
        return contentName ? `${type}: ${contentName}@${id}` : `${type}: ${id}`;
      }

      return `${type}: ${id}`;
    };

    const filteredRecords = docRecords.filter((rec) => {
      if (cmd.allVersions) return true;
      if (rec.relation !== 'has-version') return true;
      const sourceKey = `${rec.sourceType}:${rec.sourceId}->${rec.targetType}`;
      return latestEdgeSet.has(`${sourceKey}:${rec.targetId}`);
    });

    const activeVersionNodes = new Set();
    for (const rec of filteredRecords) {
      if (rec.relation !== 'has-version') continue;
      const targetNodeRaw = resolveNodeRaw(rec.targetType, rec.targetId, rec, 'target');
      activeVersionNodes.add(targetNodeRaw);
    }

    const prunedRecords = filteredRecords.filter((rec) => {
      if (rec.sourceType !== 'ContentVersion' && rec.sourceType !== 'DocumentVersion') return true;
      const sourceNodeRaw = resolveNodeRaw(rec.sourceType, rec.sourceId, rec, 'source');
      return activeVersionNodes.has(sourceNodeRaw);
    });

    const sortedRecords = [...prunedRecords].sort((a, b) => {
      const depthA = asIndex(a.details.depth);
      const depthB = asIndex(b.details.depth);
      if (depthA !== depthB) return depthA - depthB;

      const relIdxA = Math.min(asIndex(a.details.layoutRelIndex), asIndex(a.details.contentRelIndex), asIndex(a.details.styleRelIndex));
      const relIdxB = Math.min(asIndex(b.details.layoutRelIndex), asIndex(b.details.contentRelIndex), asIndex(b.details.styleRelIndex));
      if (relIdxA !== relIdxB) return relIdxA - relIdxB;

      const srcCmp = a.sourceId.localeCompare(b.sourceId);
      if (srcCmp !== 0) return srcCmp;
      return a.targetId.localeCompare(b.targetId);
    });

    for (const rec of sortedRecords) {
      const sourceType = rec.sourceType;
      const sourceId = rec.sourceId;
      const targetType = rec.targetType;
      const targetId = rec.targetId;
      const relation = rec.relation;
      const details = rec.details;
      const depthValue = Number.parseInt(details.depth, 10);

      // Skip if style exclusion is active
      if (!cmd.styles && (sourceType === 'Style' || targetType === 'Style')) continue;

      if (!cmd.fields && (sourceType === 'Field' || targetType === 'Field')) continue;

      const sourceRaw = resolveNodeRaw(sourceType, sourceId, rec, 'source');
      const targetRaw = resolveNodeRaw(targetType, targetId, rec, 'target');
      const source = sanitize(sourceRaw);
      const target = sanitize(targetRaw);
      const label = sanitize(relation);
      addNode(source, sourceType);
      addNode(target, targetType);

      if (Number.isFinite(depthValue)) {
        if (sourceType === 'DocumentVersion') setNodeDepth(source, depthValue - 1);
        if (sourceType === 'Layout') setNodeDepth(source, Math.max(depthValue - 1, 0));
        if (sourceType === 'Content') setNodeDepth(source, depthValue);
        if (sourceType === 'Document') setNodeDepth(source, -2);
        if (targetType === 'Layout') setNodeDepth(target, depthValue);
        if (targetType === 'Content') setNodeDepth(target, depthValue);
        if (targetType === 'ContentVersion') setNodeDepth(target, depthValue + 1);
        if (targetType === 'Field') setNodeDepth(target, depthValue + 1);
        if (targetType === 'Style') setNodeDepth(target, depthValue + 1);
      }

      edges.add(`  ${source} -> ${target} [label=${label}];`);
      rows.push({ source, target, sourceRaw, targetRaw, details });

      const siblingIndex = Math.min(
        asIndex(details.layoutRelIndex),
        asIndex(details.contentRelIndex),
        asIndex(details.styleRelIndex)
      );
      if (siblingIndex !== MAX_ORDER_INDEX) {
        addSibling(source, target, siblingIndex);
      }

      const path = details.path || '';
      if (path) {
        const topSegment = path.split(' > ')[0]?.trim();
        if (topSegment) {
          addClusterNode(topSegment, source);
          addClusterNode(topSegment, target);
        }
      }
    }

    const depthGroups = new Map();
    for (const [node, meta] of nodeMeta.entries()) {
      const depth = Number.isFinite(meta.depth) ? meta.depth : 99;
      if (!depthGroups.has(depth)) depthGroups.set(depth, new Set());
      depthGroups.get(depth).add(node);
    }

    const rankBlocks = [...depthGroups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([depth, nodesAtDepth]) => {
        const nodes = [...nodesAtDepth];
        if (nodes.length === 0) return '';
        return [
          `  subgraph "rank_depth_${depth}" {`,
          '    rank=same;',
          ...nodes.map((n) => `    ${n};`),
          '  }'
        ].join('\n');
      })
      .filter(Boolean);

    const clusterBlocks = [...clusterGroups.entries()].map(([cluster, nodes]) => {
      return [
        `  subgraph "cluster_${safePathSegment(cluster)}" {`,
        '    color=lightgrey;',
        `    label=${sanitize(cluster)};`,
        ...[...nodes].map((n) => `    ${n};`),
        '  }'
      ].join('\n');
    });

    const siblingOrderingEdges = [];
    for (const [, siblings] of siblingGroups.entries()) {
      const ordered = [...siblings].sort((a, b) => a.index - b.index);
      const uniqueOrdered = ordered.filter((item, idx) => idx === 0 || item.child !== ordered[idx - 1].child);
      for (let i = 0; i < uniqueOrdered.length - 1; i += 1) {
        const left = uniqueOrdered[i].child;
        const right = uniqueOrdered[i + 1].child;
        siblingOrderingEdges.push(`  ${left} -> ${right} [style=invis, weight=50];`);
      }
    }

    const dot = [
      'digraph CCS {',
      '  rankdir=TB;',
      '  node [shape=box, style=filled, fillcolor=lightgray, fontname="Helvetica"];',
      '  edge [fontname="Helvetica", fontsize=9, arrowsize=0.7];',
      ...[...nodeMeta.keys()].map(n => `  ${n};`),
      ...clusterBlocks,
      ...rankBlocks,
      ...edges,
      ...siblingOrderingEdges,
      '}'
    ].join('\n');

    return dot;
  };

  if (cmd.document) {
    const filteredRecords = records.filter((record) => record.rootDoc === cmd.document);

    if (filteredRecords.length === 0) {
      console.error(chalk.red(`❌ No data found for document "${cmd.document}".`));
      return;
    }

    const safeDocument = safePathSegment(cmd.document);
    const dotPath = path.join(reportDir, `${safeDocument}.dot`);
    const svgPath = path.join(reportDir, `${safeDocument}.svg`);

    const dot = buildGraph(cmd.document, filteredRecords);
    fs.writeFileSync(dotPath, dot);

    const result = spawnSync('dot', ['-Tsvg', dotPath], { encoding: 'utf8' });
    if (result.status === 0) {
      fs.writeFileSync(svgPath, result.stdout);
      console.log(chalk.green(`✅ Wrote SVG Graph to ${svgPath}`));
    } else {
      console.error(chalk.red('❌ Failed to generate SVG using dot.'));
      console.error(chalk.red(result.error));
    }
  } else {
    // Group lines by RootDocument
    const docsMap = new Map();
    for (const record of records) {
      const rootDoc = record.rootDoc;
      const sourceType = record.sourceType;

      // Only collect top-level Document entries
      if (rootDoc && sourceType === 'Document') {
        if (!docsMap.has(rootDoc)) {
          docsMap.set(rootDoc, []);
        }
        docsMap.get(rootDoc).push(record);
      } else if (docsMap.has(rootDoc)) {
        // Include related lines for previously registered documents
        docsMap.get(rootDoc).push(record);
      }
    }

    for (const [doc, docRecords] of docsMap.entries()) {
      const dot = buildGraph(doc, docRecords);
      const safeDoc = safePathSegment(doc);
      const dotPath = path.join(graphDir, `${safeDoc}.dot`);
      const svgPath = path.join(graphDir, `${safeDoc}.svg`);

      fs.writeFileSync(dotPath, dot);

      const result = spawnSync('dot', ['-Tsvg', dotPath], { encoding: 'utf8' });
      if (result.status === 0) {
        fs.writeFileSync(svgPath, result.stdout);
        console.log(chalk.green(`✅ Wrote SVG Graph for document "${doc}" to ${svgPath}`));
      } else {
        console.error(chalk.red(`❌ Failed to generate SVG for document "${doc}" using dot.`));
        console.error(chalk.red(result.error));
      }
    }
  }
}
