import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ensureDir } from './utils.js';

const versionParts = value => (String(value || '').match(/\d+/g) || []).map(Number);
const compareVersions = (a, b) => {
  const aa = versionParts(a), bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const generatedTimestamp = value => {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
};
const latestFile = directory => {
  if (!fs.existsSync(directory)) return null;
  const entries = fs.readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('_expanded.json'));
  if (!entries.length) return null;
  return path.join(directory, entries.sort((a, b) => compareVersions(path.parse(a).name, path.parse(b).name)).at(-1));
};
const latestVersionDirectory = directory => {
  if (!fs.existsSync(directory)) return null;
  const entries = fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (!entries.length) return null;
  return path.join(directory, entries.sort(compareVersions).at(-1));
};
const cachedDocumentFile = (cacheDir, documentName) => latestFile(path.join(cacheDir, 'documents', documentName, 'versions'));
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const scriptJson = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const items = value => Array.isArray(value) ? value : Array.isArray(value?.Items) ? value.Items : value ? [value] : [];
const styleAttributes = info => items(info.CommunicationStyleConfigStyleAttribute).map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || ''));
const previewText = value => String(value ?? '').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex, decimal) => {
  const point = parseInt(hex || decimal, hex ? 16 : 10);
  return point <= 0x10ffff ? String.fromCodePoint(point) : match;
}).replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
const previewToken = value => {
  try {
    return JSON.parse(`{${value.replaceAll('&#34;', '"').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&apos;', "'").replaceAll('&#61;', '=').replaceAll('&amp;', '&')}}`);
  } catch {
    return {};
  }
};
const previewMarkup = html => html
  .replace(/&lt;\/?comms-loop&gt;/gi, '')
  .replace(/&lt;comms-data&gt;\$Data\{([^}]*)\}&lt;\/comms-data&gt;/gi, (_, payload) => {
    const token = previewToken(payload);
    const label = token.Id || 'Field';
    const detail = [`Field: ${label}`, token.Type && `Type: ${token.Type}`, token.Format && `Format: ${token.Format}`].filter(Boolean).join(' · ');
    return `<span class="preview-token" title="${esc(detail)}">${esc(label)}</span>`;
  })
  .replace(/&lt;comms-cond&gt;\$Cond\{([^}]*)\}&lt;\/comms-cond&gt;/gi, (_, payload) => {
    const token = previewToken(payload);
    const label = token.Text || (token.Content ? `[${token.Content}]` : 'Conditional');
    return `<span class="preview-conditional" title="${esc(previewText(token.Condition || 'Conditional content'))}">${esc(previewText(label))}</span>`;
  });

function layoutIndex(cacheDir) {
  const index = new Map();
  const root = path.join(cacheDir, 'layouts');
  if (!fs.existsSync(root)) return index;
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = fs.readdirSync(dir).find(name => name.endsWith('.json') && !name.endsWith('_master.json'));
    if (!file) continue;
    const data = readJson(path.join(dir, file));
    const rec = data.CommunicationLayoutConfigRec || {};
    const info = rec.CommunicationLayoutConfigInfo || {};
    if (rec.CommunicationLayoutConfigUuid) index.set(rec.CommunicationLayoutConfigUuid, { name: info.ShortName || folder, data });
  }
  return index;
}

function contentIndex(cacheDir) {
  const index = new Map();
  const root = path.join(cacheDir, 'contents');
  if (!fs.existsSync(root)) return index;
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const config = fs.readdirSync(dir).find(name => name.endsWith('.json') && !name.endsWith('_master.json'));
    if (!config) continue;
    const data = readJson(path.join(dir, config));
    const rec = data.CommunicationContentConfigRec || {};
    const info = rec.CommunicationContentConfigInfo || data.CommunicationContentConfigInfo || {};
    const effectiveDate = (rec.Status?.Items || []).find(item => item.StatusCode === 'Active')?.EffDtTm || (rec.Status?.Items || [])[0]?.EffDtTm || '';
    index.set(info.ShortName || folder, { dir, info, effectiveDate });
  }
  return index;
}

function chartIndex(cacheDir) {
  const index = new Map();
  const root = path.join(cacheDir, "charts");
  if (!fs.existsSync(root)) return index;
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const listFile = path.join(dir, "chart.json");
    if (!fs.existsSync(listFile)) continue;
    const data = readJson(listFile);
    const record = data.ChartConfigRec || data;
    const info = record.ChartConfigInfo || {};
    const uuid = record.ChartConfigUuid;
    if (!uuid) continue;
    const versionDir = latestVersionDirectory(path.join(dir, "versions"));
    const versionFile = versionDir ? latestFile(versionDir) : null;
    const version = versionFile ? readJson(versionFile) : {};
    const plotSeries = version.ChartVersionPlot?.ChartPlotSeries || [];
    const groupInfo = data.ForeignKeyRecs?.find(item => item.ChartGroupConfigRec)?.ChartGroupConfigRec?.ChartGroupConfigInfo || {};
    const active = (record.Status?.Items || []).find(item => item.StatusCode === "Active");
    index.set(uuid, {
      uuid, name: info.ShortName || info.Name || folder, description: info.Desc || "",
      group: groupInfo.ShortName || groupInfo.Name || info.ChartGroupConfigUuid || "", configId: info.ConfigId || record.ConfigId || "",
      version: versionDir ? path.basename(versionDir) : "", effectiveDate: active?.EffDtTm || "",
      seriesCount: plotSeries.length,
      annotationCount: plotSeries.reduce((count, item) => count + (item.ChartPlotConfigAnnotations || []).length, 0),
    });
  }
  return index;
}
function styleIndex(cacheDir) {
  const index = new Map();
  const root = path.join(cacheDir, 'styles');
  if (!fs.existsSync(root)) return index;
  for (const folder of fs.readdirSync(root)) {
    const dir = path.join(root, folder);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = fs.readdirSync(dir).find(name => name.endsWith('.json') && !name.endsWith('_master.json'));
    if (!file) continue;
    const data = readJson(path.join(dir, file));
    const info = data.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    const uuid = data.CommunicationStyleConfigRec?.CommunicationStyleConfigUuid;
    if (!uuid) continue;
    index.set(uuid, {
      name: info.ShortName || info.Name || folder,
      description: info.Desc || '',
      attributes: styleAttributes(info),
    });
  }
  return index;
}

function contentDetails(name, index, charts = new Map(), stylesByUuid = new Map()) {
  const rec = index.get(name);
  if (!rec) return { name, missing: true, fields: [], conditionals: [] };
  const versionDir = latestVersionDirectory(path.join(rec.dir, 'versions'));
  if (!versionDir) return { name, description: rec.info.Desc || '', fields: [], conditionals: [] };
  const version = path.basename(versionDir);
  const versionFile = path.join(versionDir, `${version}.json`);
  const versionData = fs.existsSync(versionFile) ? readJson(versionFile) : {};
  const versionInfo = versionData.CommunicationContentVersionConfigInfo
    || versionData.CommunicationContentVersionConfigRec?.CommunicationContentVersionConfigInfo
    || {};
  const blob = fs.readdirSync(versionDir).find(item => item.endsWith('.blob'));
  const expanded = fs.readdirSync(versionDir).find(item => item.endsWith('_expanded.json'));
  const expandedData = expanded ? readJson(path.join(versionDir, expanded)) : {};
  const styles = items(expandedData.CommunicationContentVersionStyles).map(entry => {
    const relation = entry.CommunicationStyleConfigCommunicationContentVersionConfigRelRec || entry.CommunicationContentVersionStyleRec || entry;
    const relationInfo = relation.CommunicationStyleConfigCommunicationContentVersionConfigRelInfo || relation.CommunicationContentVersionStyleInfo || relation;
    const uuid = relationInfo.CommunicationStyleConfigUuid;
    const cached = stylesByUuid.get(uuid) || {};
    const embedded = entry.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || relation.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    return {
      name: embedded.ShortName || embedded.Name || cached.name || items(relationInfo.StyleClassName).join(', ') || uuid || 'Unnamed style',
      description: embedded.Desc || cached.description || '',
      attributes: embedded.CommunicationStyleConfigStyleAttribute ? styleAttributes(embedded) : cached.attributes || [],
    };
  });
  const chartUuid = expandedData.CommunicationContentVersionChart?.CommunicationContentVersionConfigChartConfigRelRec?.CommunicationContentVersionConfigChartConfigRelInfo?.ChartConfigUuid || '';
  const chart = chartUuid ? { uuid: chartUuid, ...(charts.get(chartUuid) || { name: expandedData.CommunicationContentVersionChart?.ShortName || 'Unresolved chart', missing: true }) } : null;
  const rawHtml = blob ? fs.readFileSync(path.join(versionDir, blob), 'utf8') : '';
  const previewHtml = previewMarkup(rawHtml);
  const text = rawHtml.replaceAll('&#34;', '"').replaceAll('&quot;', '"');
  const decodeCondition = value => String(value || '').replaceAll('&#61;', '=').replaceAll('&#39;', "'").replaceAll('&apos;', "'").replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  const conditionalDetails = [...text.matchAll(/\$Cond\{([^}]*)\}/g)].map(match => {
    // Rich-text blobs sometimes split a condition across styled spans. The
    // comms token survives intact, but its JSON value needs the markup removed
    // before we read Content and Condition.
    const payload = match[1].replace(/<[^>]*>/g, '');
    return {
      name: payload.match(/"Content"\s*:\s*"([^"]+)/)?.[1] || '',
      condition: decodeCondition(payload.match(/"Condition"\s*:\s*"([^"]*)/)?.[1] || ''),
    };
  }).filter(item => item.name);
  return {
    name, type: rec.info.ContentType || 'Text', version, versionDescription: versionInfo.Desc || '', effectiveDate: rec.effectiveDate || '', description: rec.info.Desc || (conditionalDetails.length ? `Conditional container for ${conditionalDetails.length} alternate content block${conditionalDetails.length === 1 ? '' : 's'}.` : ''),
    fields: [...new Set([...text.matchAll(/\$Data\{[^}]*"Id"\s*:\s*"([^"]+)/g)].map(match => match[1]))],
    conditionals: [...new Set(conditionalDetails.map(item => item.name))],
    conditionalDetails, chart, styles, previewHtml,
  };
}

function walkLayout(uuid, layouts, contents, chartsByUuid, stylesByUuid, assemblyBindings = {}, layoutBindings = {}, seen = new Set(), contentCache = new Map()) {
  if (seen.has(uuid)) return { name: '(cycle)', children: [] };
  seen.add(uuid);
  const entry = layouts.get(uuid);
  if (!entry) return { name: '(unresolved layout)', children: [] };
  const data = entry.data;
  const relations = (data.CommunicationLayoutContents || []).map(item => {
    const relation = item.CommunicationLayoutConfigCommunicationContentConfigRelRec?.CommunicationLayoutConfigCommunicationContentConfigRelInfo || {};
    const name = item.ShortName;
    const binding = assemblyBindings[`${entry.name}\u0000${name}`] || null;
    const always = relation.ContentAlwaysTriggerInd === true;
    const { previewHtml, ...detail } = contentCache.get(name) || contentCache.set(name, contentDetails(name, contents, chartsByUuid, stylesByUuid)).get(name);
    return {
      ...detail,
      // A disabled content relationship without an Assembly Template reference
      // cannot be selected at runtime. Preserve it in the inspector as never.
      always: !always && !binding ? 'never' : always,
      inclusion: always ? 'always' : binding ? 'conditional' : 'never',
      binding,
      order: Number(relation.ContentRelIndex || Number.MAX_SAFE_INTEGER),
    };
  }).sort((a, b) => a.order - b.order);
  const children = (data.CommunicationLayoutLayouts || []).map(item => {
    const relation = item.CommunicationLayoutConfigCommunicationLayoutConfigRelRec?.CommunicationLayoutConfigCommunicationLayoutConfigRelInfo || {};
    const layoutId = relation.RelCommunicationLayoutConfigUuid;
    const binding = layoutBindings[layoutId] || null;
    const always = relation.LayoutAlwaysTriggerInd === true;
    // A false relationship only renders when its owning document's Assembly
    // Template names an actual condition for that layout. Old disabled layout
    // relations are deliberately retained in Comms, but should read as never.
    const inclusion = always ? 'always' : binding?.condition ? 'conditional' : 'never';
    return { ...walkLayout(layoutId, layouts, contents, chartsByUuid, stylesByUuid, assemblyBindings, layoutBindings, new Set(seen), contentCache), always: inclusion === 'never' ? 'never' : always, inclusion, condition: binding?.condition || '', area: relation.StyleAreaName || '', order: Number(relation.LayoutRelIndex || Number.MAX_SAFE_INTEGER) };
  }).sort((a, b) => a.order - b.order);
  const occupiedAreas = new Map();
  for (const child of children) {
    if (child.inclusion === 'never') {
      child.visualSuppressed = true;
      continue;
    }
    // A false relation with no grid area has no visual placement. Keep it in
    // the inspector relationship list, but do not let CSS auto-placement make
    // it overlap an assigned sibling in the scaled document map.
    if (!child.area) {
      if (child.inclusion === 'never') child.visualSuppressed = true;
      continue;
    }
    const existing = occupiedAreas.get(child.area);
    if (!existing) {
      occupiedAreas.set(child.area, child);
      continue;
    }
    // When two retained relations occupy one source area, prefer the active
    // relation over its false/disabled counterpart.
    if (existing.inclusion === 'never' && child.inclusion !== 'never') {
      existing.visualSuppressed = true;
      occupiedAreas.set(child.area, child);
    } else {
      child.visualSuppressed = true;
    }
  }
  const styles = (data.CommunicationLayoutStyles || []).map(item => {
    const relation = item.CommunicationLayoutConfigCommunicationStyleConfigRelRec?.CommunicationLayoutConfigCommunicationStyleConfigRelInfo || {};
    const style = item.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    const cached = stylesByUuid.get(relation.CommunicationStyleConfigUuid) || {};
    const attributes = style.CommunicationStyleConfigStyleAttribute?.Items || [];
    return {
      name: style.ShortName || style.Name || cached.name || item.ShortName || 'Unnamed style',
      description: style.Desc || cached.description || '',
      attributes: attributes.length ? attributes.map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || '')) : cached.attributes || [],
    };
  });
  const info = data.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo || {};
  const allAttributes = styles.flatMap(style => style.attributes || []);
  const grid = {
    areas: allAttributes.find(attribute => attribute.startsWith('Grid-template-areas:'))?.slice('Grid-template-areas:'.length).trim() || '',
    columns: allAttributes.find(attribute => attribute.startsWith('Grid-template-columns:'))?.slice('Grid-template-columns:'.length).trim() || '',
    rows: allAttributes.find(attribute => attribute.startsWith('Grid-template-rows:'))?.slice('Grid-template-rows:'.length).trim() || '',
  };
  return { name: entry.name, type: info.LayoutType || 'Layout', description: info.Desc || '', styles, grid, contents: relations, children };
}

function packageContext(cacheDir, packageName, documentName) {
  if (!packageName) return null;
  const versionDir = path.join(cacheDir, 'packages', packageName, 'versions');
  if (!fs.existsSync(versionDir)) return { name: packageName, missing: true };
  const version = fs.readdirSync(versionDir).filter(name => fs.statSync(path.join(versionDir, name)).isDirectory()).sort(compareVersions).at(-1);
  const file = path.join(versionDir, version, 'AssemblyTemplate.json');
  if (!fs.existsSync(file)) return { name: packageName, version, missing: true };
  const assembly = readJson(file);
  const doc = (assembly.Documents || []).find(item => item.$$Id === documentName);
  const bindings = {};
  const bindingsByContent = {};
  const layoutBindings = {};
  for (const layout of doc?.Layouts || []) {
    layoutBindings[layout.$$Id] = { condition: layout.Condition || '' };
    for (const content of layout.Contents || []) {
      const iteration = content.Iteration;
      const binding = {
        layout: layout.$$Id,
        content: content.$$Id,
        condition: content.Condition || '',
        iteration: iteration ? {
          id: iteration.$$Id || '',
          type: iteration.Type || '',
          path: iteration.Path || '',
          fields: iteration.Fields || [],
        } : null,
      };
      bindings[`${layout.$$Id}\u0000${content.$$Id}`] = binding;
      (bindingsByContent[content.$$Id] ||= []).push(binding);
    }
  }
  return { name: packageName, version, description: assembly.Desc || '', condition: doc?.Condition || '', fields: assembly.Fields || [], bindings, bindingsByContent, layoutBindings };
}

function latestPackageDocuments(cacheDir, packageName) {
  const versionsDir = path.join(cacheDir, 'packages', packageName, 'versions');
  const versionDir = latestVersionDirectory(versionsDir);
  if (!versionDir) throw new Error('No cached package versions found for ' + packageName + ' at ' + versionsDir + '. Run get-everything first.');
  const file = path.join(versionDir, 'AssemblyTemplate.json');
  if (!fs.existsSync(file)) throw new Error('No cached Assembly Template found for package ' + packageName + '.');
  const assembly = readJson(file);
  return [...new Set((assembly.Documents || []).map(document => document["$" + "$Id"]).filter(Boolean))];
}

function gridCss(layouts) {
  const rules = [];
  const minRegionHeight = 42;
  const compactRegionHeight = 38;
  // Header and footer bands are structural rather than content-heavy. Their
  // immediate cells only need room for the label and metadata line.
  const isCompactBand = node => /(?:^|[\s:_-])(header|footer)(?:[\s:_-]|$)/i.test(String(node.name || ''));
  const childMinimum = (parent, child) => isCompactBand(parent) ? compactRegionHeight : minimumHeight(child);
  const flexibleTracks = value => {
    const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && /^[0-9.]+(?:px|mm|cm|in)?$/i.test(tokens[0])) return 'minmax(0,1fr)';
    if (tokens.length < 2 || tokens.some(token => !/^[0-9.]+(?:px|mm|cm|in)?$/i.test(token))) return value;
    const units = { px: 1, mm: 3.78, cm: 37.8, in: 96 };
    const amounts = tokens.map(token => {
      const match = token.match(/^([0-9.]+)(px|mm|cm|in)?$/i);
      return Number(match[1]) * (units[String(match[2] || 'px').toLowerCase()] || 1);
    });
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    return amounts.map(amount => {
      // A literal 1cm/38px centre stub is meaningful in the source document,
      // but unreadable in a scaled map. Keep its relative weight while giving
      // tracks below 15% of their grid a usable label width.
      const minimum = amount / total < 0.15 ? '54px' : '0';
      return 'minmax(' + minimum + ',' + Math.max(1, Math.round(amount)) + 'fr)';
    }).join(' ');
  };
  const areaRows = node => [...String(node.grid?.areas || '').matchAll(/'([^']+)'/g)].map(match => match[1].trim().split(/\s+/));
  const areaSpan = (rows, area) => Math.max(1, rows.reduce((count, row) => count + row.filter(value => value === area).length, 0));
  // A child that spans multiple rows should only increase those tracks when
  // their other occupants do not already provide its required height. Giving
  // every spanned row an equal share wastes vertical space beside a tall stack.
  const areaRowSpan = (rows, area) => Math.max(1, rows.reduce((count, row) => count + (row.includes(area) ? 1 : 0), 0));
  let minimumHeight;
  const rowMinimums = (node, rows) => {
    const baseMinimum = isCompactBand(node) ? compactRegionHeight : minRegionHeight;
    const children = (node.children || []).filter(child => !child.visualSuppressed);
    const minimums = rows.map(row => Math.max(baseMinimum, ...row.map(area => {
      const child = children.find(item => item.area === area);
      return child && areaRowSpan(rows, area) === 1 ? childMinimum(node, child) : baseMinimum;
    })));
    for (const child of children) {
      const span = areaRowSpan(rows, child.area);
      if (span === 1) continue;
      const indices = rows.flatMap((row, index) => row.includes(child.area) ? [index] : []);
      const available = indices.reduce((height, index) => height + minimums[index], 0) + Math.max(0, indices.length - 1) * 6;
      let remainder = Math.max(0, childMinimum(node, child) - available);
      for (const index of indices) {
        const addition = Math.ceil(remainder / (indices.length - indices.indexOf(index)));
        minimums[index] += addition;
        remainder -= addition;
      }
    }
    return minimums;
  };
  minimumHeight = node => {
    const children = (node.children || []).filter(child => !child.visualSuppressed);
    if (!children.length) return minRegionHeight;
    const rows = areaRows(node);
    if (String(node.type || '').toLowerCase() === 'grid' && rows.length) {
      return (isCompactBand(node) ? 34 : 42) + rowMinimums(node, rows).reduce((height, rowMinimum) => height + rowMinimum, 0) + Math.max(0, rows.length - 1) * 6 + (isCompactBand(node) ? 10 : 6);
    }
    return minRegionHeight + children.reduce((height, child) => height + minimumHeight(child), 0) + Math.max(0, children.length - 1) * 6;
  };
  const inferredRows = node => {
    const rows = areaRows(node);
    if (!rows.length) return '';
    return rowMinimums(node, rows).map(rowMinimum => 'minmax(' + rowMinimum + 'px,max-content)').join(' ');
  };
  const visit = (node, id) => {
    if (String(node.type).toLowerCase() === 'grid' && node.grid?.areas && node.children.length > 0) {
      const selector = '[data-node="' + id + '"]';
      const rows = node.grid.rows ? flexibleTracks(node.grid.rows) : inferredRows(node);
      const sourceRows = areaRows(node);
      const spans = area => areaSpan(sourceRows, area);
      const isSingleColumnStack = sourceRows.every(row => row.length === 1);
      const childHeight = isCompactBand(node) ? compactRegionHeight : minRegionHeight;
      const labelBand = isCompactBand(node) ? 34 : 42;
      rules.push(selector + '{display:grid;position:relative;padding-top:' + labelBand + 'px;padding-bottom:' + (isCompactBand(node) ? 10 : 6) + 'px;gap:6px;overflow:hidden;grid-auto-rows:minmax(' + childHeight + 'px,auto);grid-template-areas:' + node.grid.areas + ';' + (node.grid.columns ? 'grid-template-columns:' + flexibleTracks(node.grid.columns) + ';' : '') + (rows ? 'grid-template-rows:' + rows + ';' : '') + '}');
      rules.push('#comms-inspector ' + selector + '>b,#comms-inspector ' + selector + '>small{position:absolute;left:6px;right:6px;width:auto;max-width:calc(100% - 12px);z-index:1}');
      rules.push(selector + '>b{top:6px}' + selector + '>small{top:18px}' + selector + '>.region{margin:0;min-width:0;min-height:' + childHeight + 'px;overflow:hidden}');
      node.children.forEach((child, index) => {
        if (child.area) rules.push('[data-node="' + id + '-' + index + '"]{grid-area:' + child.area + '}');
        const hasVisibleChildren = (child.children || []).some(grandchild => !grandchild.visualSuppressed);
        const sharesRowWithNestedPeer = sourceRows.some(row => row.includes(child.area) && row.some(area => {
          const peer = node.children.find(item => item.area === area);
          return area !== child.area && spans(area) === 1 && (peer?.children || []).some(grandchild => !grandchild.visualSuppressed);
        }));
        const endsSingleColumnStack = isSingleColumnStack && sourceRows.at(-1)?.[0] === child.area;
        // A leaf beside a real nested layout (or spanning source rows) should
        // fill that structural cell. Isolated leaves remain a compact label.
        if (!hasVisibleChildren && spans(child.area) === 1 && !sharesRowWithNestedPeer && !endsSingleColumnStack) rules.push('[data-node="' + id + '-' + index + '"]{align-self:start}');
        if (child.visualSuppressed) rules.push('[data-node="' + id + '-' + index + '"]{display:none}');
      });
    }
    node.children.forEach((child, index) => visit(child, id + '-' + index));
  };
  layouts.forEach((node, index) => visit(node, 'layout-' + index));
  return rules.join('');
}

// The inspector has one stable responsibility: describe the selected document
// item. Content and field drill-downs deliberately keep their own panels so a
// user never loses the layout context while following a field binding.
function canonicalInspectorScript(model) {
  const shell = `<style>
/* Keep the generated map visually close to the established mockup: a compact
   portrait sheet and distinct, softly coloured document/layout regions. */
#comms-inspector{grid-template-columns:minmax(420px,1fr) minmax(420px,1fr)}
#comms-inspector .page{min-height:0;aspect-ratio:auto;position:relative;padding:42px 6% 5%}
#comms-inspector .page{width:min(100%,650px)}
#comms-inspector .page.document-node{cursor:pointer}
#comms-inspector .page.document-node.selected{outline:3px solid #e36c2e;outline-offset:4px}
#comms-inspector .node-title{position:absolute;top:7px;left:9px;font-size:11px;font-weight:750}
#comms-inspector .node-meta{position:absolute;top:23px;left:9px;font-size:9px;color:#60707c}
#comms-inspector #document-map{position:relative;left:auto;right:auto;top:auto;bottom:auto;display:grid;gap:8px;min-height:0}
#comms-inspector #document-map>.region{margin:0;min-height:0}
#comms-inspector .region{min-height:56px;overflow:visible}
#comms-inspector .region b,#comms-inspector .region small{display:block;width:100%;max-width:100%;min-width:0;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#comms-inspector .region.layout-grid{background:#dff4fa96;border-color:#5d93aa}
#comms-inspector .region.layout-block{background:#fff9e8cc;border-color:#b99b55}
#comms-inspector #detail{max-height:250px}
#comms-inspector #content-detail{background:#fbfdfe}
#comms-inspector #content-panel{background:#fff}
#comms-inspector li:has(.trigger.never) .content-link{color:#98a3a9}
#comms-inspector .inspector-row{margin:7px 0;font-size:12px}
#comms-inspector .inspector-row strong{display:inline-block;min-width:76px;color:#63717c;font-size:11px;letter-spacing:.05em;text-transform:uppercase}
#comms-inspector .copy-name,#comms-inspector .preview-icon{margin-left:4px;padding:0 2px;border:0;background:none;color:#63717c;font-size:13px;line-height:1;vertical-align:middle;cursor:pointer}
#comms-inspector .copy-name:hover,#comms-inspector .preview-icon:hover{color:#145b78}
#comms-inspector .preview-icon svg{display:block}
#comms-inspector .content-title{display:flex;align-items:baseline;gap:2px}
#comms-inspector .condition-chip{margin-left:6px;border:0;cursor:pointer}
#comms-inspector .condition-detail{display:block;margin:5px 0 2px;padding:4px 6px;background:#eef7fa;color:#285060;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
#comms-inspector .condition-detail[hidden]{display:none}
#content-preview-dialog{width:min(960px,calc(100vw - 40px));max-height:90vh;box-sizing:border-box}
#content-preview-dialog .preview-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}
#content-preview-dialog .preview-heading h2{margin:0}
#content-preview-dialog .preview-note{font-size:12px;color:#5e6f7b}
#content-preview-frame{display:block;width:100%;height:min(65vh,700px);box-sizing:border-box;border:1px solid #b7c6cc;background:white}
</style><script>(()=>{
const m=__MODEL__,inspector=document.querySelector('#detail'),content=document.querySelector('#content-detail'),fieldPanel=document.querySelector('#content-panel');
let selected='document',trail=[],contentOrigin=null;const byId=new Map();
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const button=(kind,value,label)=>'<button class="content-link" data-canonical="'+kind+'" data-value="'+encodeURIComponent(value)+'">'+esc(label||value)+'</button>';
const copyButton=value=>'<button class="copy-name" data-canonical="copy" data-value="'+encodeURIComponent(value)+'" title="Copy content name" aria-label="Copy '+esc(value)+'">⧉</button>';
const previewButton=()=>'<button class="preview-icon" data-canonical="preview" title="Preview HTML" aria-label="Preview HTML"><svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>';
const copyValueButton=(value,label)=>'<button class="copy-name" data-canonical="copy" data-value="'+encodeURIComponent(value)+'" title="Copy '+esc(label)+'" aria-label="Copy '+esc(label)+'">⧉</button>';
const conditionControl=condition=>'<button class="trigger off condition-chip" data-canonical="condition" aria-expanded="false">conditional</button><span class="condition-detail" hidden>'+esc(condition)+'</span>';
const index=(node,id)=>{node.id=id;byId.set(id,node);node.children.forEach((child,i)=>index(child,id+'-'+i))};m.layouts.forEach((node,i)=>index(node,'layout-'+i));
const draw=node=>'<div class="region" data-node="'+node.id+'"><b>'+esc(node.name)+'</b><small>'+esc(node.type)+' · '+node.contents.length+' contents</small>'+node.children.map(draw).join('')+'</div>';
document.querySelector('#document-map').innerHTML=m.layouts.map(draw).join('');
const documentNode={id:'document',name:m.document.name,type:'Document',description:m.document.description,always:false,children:m.layouts,contents:[],styles:m.document.styles};
const page=document.querySelector('#page'),title=page.querySelector('.page-title'),map=document.querySelector('#document-map'),minimum=42,compactMinimum=45;
page.dataset.node='document';page.classList.add('document-node');title.className='node-title';title.textContent=m.document.name;page.insertAdjacentHTML('beforeend','<span class="node-meta">Document · A4+ portrait</span>');
const compactBand=node=>/(?:^|[\\s:_-])(header|footer)(?:[\\s:_-]|$)/i.test(String(node.name||''));
let rootMinimum;
const rootRowMinimums=(node,children,rows)=>{
  const base=compactBand(node)?compactMinimum:minimum;
  const span=area=>Math.max(1,rows.reduce((count,row)=>count+(row.includes(area)?1:0),0));
  const values=rows.map(row=>Math.max(base,...row.map(area=>{
    const child=children.find(item=>item.area===area);
    return child&&span(area)===1?rootMinimum(child):base;
  })));
  for(const child of children){
    if(span(child.area)===1)continue;
    const indices=rows.flatMap((row,index)=>row.includes(child.area)?[index]:[]);
    let remainder=Math.max(0,rootMinimum(child)-(indices.reduce((height,index)=>height+values[index],0)+Math.max(0,indices.length-1)*6));
    for(const index of indices){const addition=Math.ceil(remainder/(indices.length-indices.indexOf(index)));values[index]+=addition;remainder-=addition}
  }
  return values;
};
rootMinimum=node=>{
  const children=(node.children||[]).filter(child=>!child.visualSuppressed);
  const rows=[...String(node.grid?.areas||'').matchAll(/'([^']+)'/g)].map(match=>match[1].trim().split(/\s+/));
  if(!children.length)return minimum;
  if(String(node.type||'').toLowerCase().includes('grid')&&rows.length)return (compactBand(node)?34:42)+rootRowMinimums(node,children,rows).reduce((height,value)=>height+value,0)+Math.max(0,rows.length-1)*6;
  return minimum+children.reduce((height,child)=>height+rootMinimum(child),0)+Math.max(0,children.length-1)*6;
};
/* Bill and statement pages use a deliberately soft 1:2:1 header/detail/footer allocation. Header and footer cells receive a compact two-line minimum, while the cached grid styles continue to control the geometry within each region. The root minimum prevents a weighted row from collapsing over its own children. Footer rows use their content height instead of absorbing spare page height. */map.style.gridTemplateRows=m.layouts.map(node=>{const name=String(node.name).toLowerCase(),weight=name.includes('footer') ? 1 : name.includes('header') ? (name.includes('address') ? .6 : .2) : name.includes('charges') ? .2 : (name.includes('detail')||name.includes('body')||name.includes('overall_grid')) ? 2 : 1;return 'minmax('+rootMinimum(node)+'px,'+(name.includes('footer')?'auto':weight+'fr')+')'}).join(' ');
const rootTracks=map.style.gridTemplateRows.split(' ');m.layouts.forEach((node,index)=>{if(/(?:^|[\\s:_-])(header|charges)(?:[\\s:_-]|$)/i.test(String(node.name||'')))rootTracks[index]='minmax('+rootMinimum(node)+'px,auto)'});map.style.gridTemplateRows=rootTracks.join(' ');
map.style.gridTemplateRows=m.layouts.map(node=>'minmax('+rootMinimum(node)+'px,max-content)').join(' ');
for(const [id,node] of byId){const element=document.querySelector('[data-node="'+id+'"]'),type=String(node.type||'').toLowerCase();if(element){element.classList.add(type.includes('grid')?'layout-grid':type.includes('block')?'layout-block':'layout-other');if(node.visualSuppressed)element.style.display='none';else if(/^layout-[0-9]+$/.test(id)&&!(node.children||[]).some(child=>!child.visualSuppressed))element.style.alignSelf='start'}}
const trigger=value=>value==='never'?'<span class="trigger off never">never</span>':value===false?'<span class="trigger off">conditional</span>':'<span class="trigger">always</span>';
const bindingFor=(name,node=byId.get(selected))=>(node?.contents||[]).find(item=>item.name===name)?.binding || (m.package?.bindingsByContent?.[name]||[])[0] || null;
const bindingForField=(contentName,field,seen=new Set)=>{if(seen.has(contentName))return null;seen.add(contentName);const direct=bindingFor(contentName);if((direct?.iteration?.fields||[]).some(item=>(item.Name||item['$$Id'])===field))return direct;for(const child of m.content[contentName]?.conditionals||[]){const nested=bindingForField(child,field,seen);if(nested)return nested}return direct};
const fields=(name,seen=new Set)=>{if(seen.has(name))return [];seen.add(name);const item=m.content[name]||{};return [...new Set([...(item.fields||[]),...(item.conditionals||[]).flatMap(child=>fields(child,seen))])]} ;
function clearDetailPanels(){content.innerHTML='<p class="empty">Choose Contents, Styles, or Child layouts in the Inspector.</p>';fieldPanel.innerHTML='<p class="empty">Choose a field or style in Content details</p>';trail=[];contentOrigin=null}
function packageContext(){content.innerHTML='<p class="path">Details panel › Package context</p><h2>'+esc(m.package?.name||'No package')+'</h2><p>'+esc(m.package?.description||'No package description found.')+'</p><div class="chips"><span class="chip">v'+esc(m.package?.version||'unknown')+'</span><button class="chip trigger off" data-canonical="package-condition" data-value="open">conditional</button></div><h3>Document condition</h3><p>This Assembly Template expression decides whether this document is included. '+button('package-condition','open','Open full condition')+'</p>';fieldPanel.innerHTML='<p class="empty">Select a content in the Details panel.</p>'}
function showInspector(id){const node=id==='document'?documentNode:byId.get(id);if(!node)return;selected=id;document.querySelectorAll('.selected').forEach(el=>el.classList.remove('selected'));document.querySelector('[data-node="'+id+'"]').classList.add('selected');const children=node.children.length,contents=node.contents.length,styles=node.styles.length;const layoutLabel=id==='document'?children+' layouts':children+' child layouts';const styleLabel=id==='document'?styles+' document styles':styles+' styles';const conditionState=node.condition?conditionControl(node.condition):trigger(node.always);const versionDetail='Ver: '+esc(m.document.version)+(m.document.versionDescription?' · '+esc(m.document.versionDescription):'');inspector.innerHTML='<p class="path">'+(id==='document'?'Document':'Document › '+esc(node.name))+'</p><div class="content-title"><h2>'+esc(node.name)+'</h2>'+copyValueButton(node.name,'layout name')+'</div><p>'+esc(node.description||'No description found.')+'</p><p class="inspector-row document-version">'+versionDetail+'</p><p class="inspector-row"><strong>Condition:</strong> '+conditionState+'</p><p class="inspector-row"><strong>Layouts:</strong> '+button('layouts',id,layoutLabel)+'</p><p class="inspector-row"><strong>Contents:</strong> '+button('contents',id,contents+' contents')+'</p><p class="inspector-row"><strong>Styles:</strong> '+button('styles',id,styleLabel)+'</p>'+(id==='document'?'<p class="inspector-row"><strong>Package:</strong> '+button('package','open',m.package?.name||'No package')+'</p><p class="inspector-row"><strong>Generated:</strong> '+esc(m.generatedLabel||m.generatedAt||'Unknown')+'</p>':'');if(id==='document')packageContext();else clearDetailPanels()}
function listContents(node){contentOrigin={nodeId:node.id};trail=[];content.innerHTML='<p class="path">Content details › Contents</p><h2>'+esc(node.name)+'</h2><h3>Contents</h3>'+(node.contents.length?'<ul>'+node.contents.map(item=>'<li>'+button('content',item.name,(item.chart?'[Chart] ':'')+item.name)+copyButton(item.name)+' '+(item.binding?.condition?conditionControl(item.binding.condition):trigger(item.always))+'</li>').join('')+'</ul>':'<p>No direct contents.</p>');fieldPanel.innerHTML='<p class="empty">Choose a content in Content details.</p>'}
function listStyles(node){content.innerHTML='<p class="path">Content details › Styles</p><h2>'+esc(node.name)+'</h2><h3>Applied styles</h3>'+(node.styles.length?'<ul>'+node.styles.map(item=>'<li>'+button('style',item.name,item.name)+'</li>').join('')+'</ul>':'<p>No applied styles.</p>');fieldPanel.innerHTML='<p class="empty">Select a style to see its attributes.</p>'}
function listLayouts(node){content.innerHTML='<p class="path">Content details › Child layouts</p><div class="content-title"><h2>'+esc(node.name)+'</h2>'+copyValueButton(node.name,'layout name')+'</div><h3>Child layouts</h3>'+(node.children.length?'<ul>'+node.children.map(item=>'<li>'+button('layout',item.id,item.name)+copyValueButton(item.name,'layout name')+' '+trigger(item.always)+'</li>').join('')+'</ul>':'<p>No child layouts.</p>');fieldPanel.innerHTML='<p class="empty">Select a child layout to inspect it.</p>'}
function showContent(name,push=true){const item=m.content[name]||{name,fields:[],conditionals:[],conditionalDetails:[]};if(push)trail.push({name,binding:bindingFor(name)});const conditions=item.conditionalDetails||item.conditionals.map(target=>({name:target,condition:''}));const returnTarget=trail.length>1?trail.at(-2).name:contentOrigin?.nodeId&&byId.get(contentOrigin.nodeId)?.name;const back=returnTarget?button('back','', '← '+returnTarget):'';const chartInfo=item.chart?'<h3>Chart placeholder</h3><p><strong>Chart configuration:</strong> '+esc(item.chart.name||'Unresolved chart')+'</p><p>'+esc(item.chart.description||'No description found.')+'</p><p><strong>Chart group:</strong> '+esc(item.chart.group||'Unknown')+'</p><p><strong>Chart version:</strong> '+esc(item.chart.version||'Unknown')+' / '+esc(item.chart.seriesCount||0)+' series / '+esc(item.chart.annotationCount||0)+' annotations</p>'+(item.chart.missing?'<p>Referenced chart configuration is not present in the cache.</p>':''):'';const versionDetail='Ver: '+esc(item.version||'unknown')+(item.versionDescription?' · '+esc(item.versionDescription):'');content.innerHTML='<p class="path">Content details</p>'+back+'<div class="content-title"><h2>'+esc(name)+'</h2>'+copyButton(name)+(item.previewHtml?previewButton():'')+'</div><p class="muted content-version">'+versionDetail+'</p><h3>Description</h3><p>'+esc(item.description||'No description found.')+'</p>'+chartInfo+'<h3>Conditionals</h3>'+(conditions.length?'<ul>'+conditions.map(item=>'<li>'+button('content',item.name,item.name)+copyButton(item.name)+(item.condition?conditionControl(item.condition):'')+'</li>').join('')+'</ul>':'<p>No conditional content references found.</p>')+'<h3>Fields</h3>'+(fields(name).length?'<ul>'+fields(name).map(item=>'<li>'+button('field',item,item)+'</li>').join('')+'</ul>':'<p>No fields found.</p>')+'<h3>Styles</h3>'+((item.styles||[]).length?'<ul>'+item.styles.map((style,index)=>'<li>'+button('content-style',index,style.name)+'</li>').join('')+'</ul>':'<p>No styles found.</p>');fieldPanel.innerHTML='<p class="empty">Choose a field or style in Content details</p>'}
function showPreview(){const item=m.content[trail.at(-1)?.name];if(!item?.previewHtml)return;const dialog=document.querySelector('#content-preview-dialog');dialog.querySelector('#content-preview-title').textContent=item.name;dialog.querySelector('iframe').srcdoc='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; img-src data:; style-src \\'unsafe-inline\\'; font-src data:"><style>body{margin:16px;font:14px system-ui;color:#172534}figure.table{float:none!important;width:100%!important;max-width:100%;margin:0 0 16px}table{width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse}th,td{width:auto!important;border:1px solid #b7c6cc;padding:6px!important;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}.preview-token,.preview-conditional{display:inline-block;margin:2px 3px 2px 0;border-radius:999px;padding:2px 7px;line-height:1.3;cursor:help}.preview-token{color:#1c6080;background:#e6f3f8}.preview-conditional{color:#634e17;background:#fff2cb}</style></head><body>'+item.previewHtml+'</body></html>';dialog.showModal()}
function showField(name){const current=trail.at(-1),binding=bindingForField(current?.name||'',name)||current?.binding||bindingFor(current?.name||'');const iteratorField=(binding?.iteration?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const top=(m.package?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const value=iteratorField||top||{};const iteration=binding?.iteration;const iterationPath=iteration?.path||'No iteration path found.';const fieldPath=value.Path||'No field definition found.';fieldPanel.innerHTML='<p class="path">Field details</p><div class="content-title"><h2>'+esc(name)+'</h2>'+copyValueButton(name,'field name')+'</div>'+(iteration?'<h3>Iteration</h3><p>'+esc(iteration.id||'Unnamed iterator')+(iteration.type?' · '+esc(iteration.type):'')+'</p><h3>Iteration path '+copyValueButton(iterationPath,'iteration path')+'</h3><p>'+esc(iterationPath)+'</p>'+(binding.condition?'<h3>Content condition '+copyValueButton(binding.condition,'content condition')+'</h3><p>'+esc(binding.condition)+'</p>':''):'<h3>Assembly template</h3><p>Top-level field definition.</p>')+'<h3>Field path '+copyValueButton(fieldPath,'field path')+'</h3><p>'+esc(fieldPath)+'</p>'}
function showStyle(name,contentStyle=false){const node=byId.get(selected),style=contentStyle?(m.content[trail.at(-1)?.name]?.styles||[])[Number(name)]||{}:(node?.styles||[]).find(item=>item.name===name)||m.document.styles.find(item=>item.name===name)||{};fieldPanel.innerHTML='<p class="path">Style details</p><h2>'+esc(style.name||name)+'</h2><h3>Attributes</h3>'+((style.attributes||[]).length?'<ul>'+style.attributes.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>':'<p>No attributes recorded.</p>')}
function copyName(value,target){const copied=()=>{const label=target.textContent;target.textContent='✓';setTimeout(()=>{target.textContent=label},1200)};const fallback=()=>{const input=document.createElement('textarea');input.value=value;input.style.position='fixed';input.style.opacity='0';document.body.append(input);input.select();if(document.execCommand)document.execCommand('copy');input.remove();copied()};if(navigator.clipboard?.writeText)navigator.clipboard.writeText(value).then(copied).catch(fallback);else fallback()}
function showVersion(value){const item=value==='document'?m.document:m.content[value]||byId.get(value)||{};const effective=item.effectiveDate?'<h3>Effective date</h3><p>'+esc(item.effectiveDate)+'</p>':'';content.innerHTML='<p class="path">Content details › Version metadata</p><h2>'+esc(item.name||value)+'</h2><h3>Version</h3><p>Ver: '+esc(item.version||m.document.version||'unknown')+'</p>'+effective;fieldPanel.innerHTML='<p class="empty">Version metadata is shown in Content details.</p>'}
document.addEventListener('click',event=>{const node=event.target.closest('[data-node]');if(node){event.preventDefault();event.stopImmediatePropagation();showInspector(node.dataset.node);return}const action=event.target.closest('[data-canonical]');if(!action)return;event.preventDefault();event.stopImmediatePropagation();const kind=action.dataset.canonical,value=decodeURIComponent(action.dataset.value||'');const nodeForAction=value==='document'?documentNode:byId.get(value)||byId.get(selected);if(kind==='contents')listContents(nodeForAction);else if(kind==='styles')listStyles(nodeForAction);else if(kind==='layouts')listLayouts(nodeForAction);else if(kind==='layout')showInspector(value);else if(kind==='content')showContent(value,true);else if(kind==='back'){if(trail.length>1){trail.pop();showContent(trail.at(-1).name,false)}else{const origin=contentOrigin&&byId.get(contentOrigin.nodeId);if(origin)listContents(origin)}}else if(kind==='condition'){const detail=action.nextElementSibling;if(detail){detail.hidden=!detail.hidden;action.setAttribute('aria-expanded',String(!detail.hidden))}}else if(kind==='copy')copyName(value,action);else if(kind==='field')showField(value);else if(kind==='style')showStyle(value);else if(kind==='content-style')showStyle(value,true);else if(kind==='preview')showPreview();else if(kind==='version')showVersion(value);else if(kind==='package'||kind==='package-condition')document.querySelector('#package-dialog').showModal()},true);
document.querySelector('#content-preview-dialog').addEventListener('close',event=>{event.target.querySelector('iframe').srcdoc='' });
document.querySelector('#close')?.addEventListener('click',()=>{inspector.innerHTML='<p class="empty">Select a document region to inspect it.</p>';clearDetailPanels()});showInspector(selected);
})();</script>`;
  return shell.replace('__MODEL__', () => scriptJson(model));
}

function renderMockupHtml(model) {
  const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>__TITLE__ document inspector</title><style>
#comms-inspector{color:#18232d;font-family:ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:minmax(480px,560px) minmax(380px,1fr);gap:18px;min-height:680px}.toolbar{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 12px}.toolbar strong{font-size:18px;margin-right:10px}.toolbar span,.hint,.path{color:#63717c;font-size:12px}.stage{overflow:auto;min-height:620px;padding:8px 14px 22px;background:#edf1f3;display:grid;place-items:start center}.page{width:min(100%,520px);min-height:680px;border:1px solid #80909b;background:#fff;box-shadow:0 5px 18px #0002;padding:32px 10px 12px;box-sizing:border-box}.page-title{font-size:11px;font-weight:750}.region{border:1px solid #5d93aa;background:#dff4fa96;color:#15303d;padding:6px;margin:8px 0;box-sizing:border-box;cursor:pointer}.region.child{background:#fff9e8cc;border-color:#b99b55;margin:7px 0 0}.region b,.region small{display:block;pointer-events:none}.region b{font-size:10px}.region small{font-size:8px;line-height:1.2;margin-top:2px;color:#3b6475}.region:hover,.region.selected{outline:3px solid #e36c2e;outline-offset:1px}.inspector{border:1px solid #cdd7dc;background:#fff;align-self:start;position:sticky;top:10px}.inspector-heading{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #d8e0e4;font-weight:700}#close,#package-info{background:none;color:inherit;border:0}#close{font-size:22px}#package-info{color:#20576d;font-size:12px;font-weight:650}#detail,#content-detail,#content-panel{padding:14px}#detail{max-height:220px;overflow:auto}#content-detail{border-top:1px solid #d8e0e4;min-height:120px}#content-panel{border-top:1px solid #d8e0e4;min-height:210px;max-height:330px;overflow:auto}h2{font-size:18px;margin:0 0 5px}h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#63717c;margin:19px 0 7px}p{margin:4px 0;font-size:13px;line-height:1.45}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{font-size:11px;padding:3px 7px;border-radius:999px;background:#e5f4f8;color:#285060;border:0}ul{margin:5px 0;padding-left:18px}li{font-size:12px;line-height:1.55}.empty{color:#63717c;padding:24px 6px}.content-link{border:0;background:none;color:#145b78;padding:0;text-align:left;text-decoration:underline;cursor:pointer}.trigger{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:8px;font-size:10px;line-height:1.25;color:#245b3d;background:#e5f5ea}.trigger.off{color:#8c3030;background:#fbe8e8}dialog{width:min(900px,calc(100vw - 40px));max-height:80vh;border:1px solid #b7c6cc;padding:24px}dialog::backdrop{background:#0008}dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.4;background:#f1f5f6;padding:12px;max-height:42vh;overflow:auto}@media(max-width:900px){#comms-inspector{grid-template-columns:1fr}.inspector{position:static}.stage{min-height:0}}
</style></head><body><main id="comms-inspector"><section class="workspace"><header class="toolbar"><div><strong>__TITLE__</strong><span>__DESCRIPTION__ · version __VERSION__</span></div><div class="hint">Select any outlined region</div></header><div class="stage"><div class="page" id="page"><span class="page-title">__TITLE__</span><div id="document-map"></div></div></div></section><aside class="inspector"><div class="inspector-heading"><span>Inspector</span><span>__PACKAGE_BUTTON__<button id="close" title="Clear selection">×</button></span></div><div id="detail"></div><section id="content-detail"></section><section id="content-panel"></section></aside></main><dialog id="package-dialog"><form method="dialog"><button>Close</button></form><p class="path">Package context</p><h2>__TITLE__ package binding</h2><div id="package-summary"></div><h3>Document trigger condition</h3><pre id="package-condition"></pre></dialog><dialog id="content-preview-dialog"><div class="preview-heading"><h2 id="content-preview-title"></h2><form method="dialog"><button aria-label="Close preview">Close</button></form></div><p class="preview-note">Approximate HTML preview. Tables use readable widths; field values and conditions are not evaluated. Hover over chips for details.</p><iframe id="content-preview-frame" title="Content HTML preview" sandbox="" referrerpolicy="no-referrer"></iframe></dialog></body></html>`;
  return shell.replace('</style>', gridCss(model.layouts) + '</style>').replace('</body>', () => canonicalInspectorScript(model) + '</body>').replaceAll('__MODEL__', () => scriptJson(model)).replaceAll('__TITLE__', esc(model.document.name)).replaceAll('__DESCRIPTION__', esc(model.document.description)).replaceAll('__VERSION__', esc(model.document.version)).replaceAll('__PACKAGE_BUTTON__', '');
}

export async function mockupCommand(documentName, cmd) {
  const opts = typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : cmd || {};
  const cacheDir = path.resolve(opts.cache || './comms_cache');
  if (opts.all) {
    if (!opts.package) throw new Error('Package-wide mockup generation requires --package <name>.');
    const documents = latestPackageDocuments(cacheDir, opts.package);
    if (!documents.length) throw new Error('No documents were found in the latest cached Assembly Template for ' + opts.package + '.');
    const outputDir = path.resolve(opts.output || path.join(cacheDir, 'mockups', opts.package));
    ensureDir(outputDir);
    let generated = 0;
    const failures = [];
    for (const name of documents) {
      if (!cachedDocumentFile(cacheDir, name)) {
        console.warn(chalk.yellow(`⚠ Skipped ${name}: the package Assembly Template references a document with no cached version.`));
        continue;
      }
      try {
        await mockupCommand(name, { ...opts, all: false, output: path.join(outputDir, name + '-inspector.html') });
        generated += 1;
      } catch (error) {
        failures.push({ name, error });
        console.error(chalk.red('Failed ' + name + ': ' + error.message));
      }
    }
    console.log(chalk.green('Generated ' + generated + '/' + documents.length + ' mockups in ' + outputDir));
    if (failures.length) throw new Error('Package mockup generation finished with ' + failures.length + ' failure(s).');
    return;
  }
  if (!documentName) throw new Error('Specify a document name, or use --package <name> --all.');
  const documentDir = path.join(cacheDir, 'documents', documentName, 'versions');
  const documentFile = cachedDocumentFile(cacheDir, documentName);
  if (!documentFile) throw new Error(`No cached document versions found for ${documentName} at ${documentDir}. Run get-everything first.`);
  const document = readJson(documentFile);
  const info = document.CommunicationDocumentConfigRec?.CommunicationDocumentConfigInfo || {};
  const versionInfo = document.CommunicationDocumentVersionConfigRec?.CommunicationDocumentVersionConfigInfo || {};
  const layouts = layoutIndex(cacheDir), contents = contentIndex(cacheDir), chartsByUuid = chartIndex(cacheDir), stylesByUuid = styleIndex(cacheDir);
  const contentCache = new Map();
  const packageInfo = packageContext(cacheDir, opts.package, info.ShortName || documentName);
  const rootLayouts = (document.CommunicationDocumentVersionLayouts || []).map(item => {
    const relation = item.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec?.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo || {};
    return {
      ...walkLayout(relation.CommunicationLayoutConfigUuid, layouts, contents, chartsByUuid, stylesByUuid, packageInfo?.bindings, packageInfo?.layoutBindings, new Set(), contentCache),
      always: relation.LayoutAlwaysTriggerInd === true ? true : (packageInfo?.layoutBindings?.[relation.CommunicationLayoutConfigUuid]?.condition ? false : 'never'),
      inclusion: relation.LayoutAlwaysTriggerInd === true ? 'always' : (packageInfo?.layoutBindings?.[relation.CommunicationLayoutConfigUuid]?.condition ? 'conditional' : 'never'),
      condition: packageInfo?.layoutBindings?.[relation.CommunicationLayoutConfigUuid]?.condition || '',
      order: Number(relation.LayoutRelIndex || Number.MAX_SAFE_INTEGER),
      placement: relation.LayoutPlacement || 'Relative',
    };
  }).sort((a, b) => a.order - b.order);
  rootLayouts.filter(layout => layout.inclusion === 'never').forEach(layout => { layout.visualSuppressed = true; });
  // Keep the standalone artifact focused: include only content reachable from the
  // selected document, including transitive <comms-cond> content references.
  const selectedContent = new Map();
  const addContent = name => {
    if (selectedContent.has(name)) return;
    const detail = contentCache.get(name) || contentCache.set(name, contentDetails(name, contents, chartsByUuid, stylesByUuid)).get(name);
    selectedContent.set(name, detail);
    detail.conditionals.forEach(addContent);
  };
  const collectLayoutContent = layout => {
    layout.contents.forEach(item => addContent(item.name));
    layout.children.forEach(collectLayoutContent);
  };
  rootLayouts.forEach(collectLayoutContent);
  const content = Object.fromEntries(selectedContent);
  const documentStyles = (document.CommunicationDocumentVersionStyles || []).map(item => {
    const style = item.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    const attributes = style.CommunicationStyleConfigStyleAttribute?.Items || [];
    return {
      name: style.ShortName || style.Name || 'Unnamed style',
      description: style.Desc || '',
      attributes: attributes.map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || '')),
    };
  });
  const generatedAt = new Date();
  const model = { generatedAt: generatedAt.toISOString(), generatedLabel: generatedTimestamp(generatedAt), cacheDir, document: { name: info.ShortName || documentName, description: info.Desc || '', version: versionInfo.ShortName || path.basename(documentFile, '.json'), versionDescription: versionInfo.Desc || '', styles: documentStyles }, package: packageInfo, layouts: rootLayouts, content };
  const output = path.resolve(opts.output || path.join(cacheDir, `${documentName}-inspector.html`));
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, renderMockupHtml(model));
  console.log(chalk.green(`Generated ${output}`));
  console.log(chalk.gray(`Latest cached document version: ${model.document.version}`));
}
