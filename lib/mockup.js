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
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

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
    const attributes = info.CommunicationStyleConfigStyleAttribute?.Items || [];
    index.set(uuid, {
      name: info.ShortName || info.Name || folder,
      description: info.Desc || '',
      attributes: attributes.map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || '')),
    });
  }
  return index;
}

function contentDetails(name, index, charts = new Map()) {
  const rec = index.get(name);
  if (!rec) return { name, missing: true, fields: [], conditionals: [] };
  const versionDir = latestVersionDirectory(path.join(rec.dir, 'versions'));
  if (!versionDir) return { name, description: rec.info.Desc || '', fields: [], conditionals: [] };
  const version = path.basename(versionDir);
  const blob = fs.readdirSync(versionDir).find(item => item.endsWith('.blob'));
  const expanded = fs.readdirSync(versionDir).find(item => item.endsWith('_expanded.json'));
  const expandedData = expanded ? readJson(path.join(versionDir, expanded)) : {};
  const chartUuid = expandedData.CommunicationContentVersionChart?.CommunicationContentVersionConfigChartConfigRelRec?.CommunicationContentVersionConfigChartConfigRelInfo?.ChartConfigUuid || '';
  const chart = chartUuid ? { uuid: chartUuid, ...(charts.get(chartUuid) || { name: expandedData.CommunicationContentVersionChart?.ShortName || 'Unresolved chart', missing: true }) } : null;
  const text = blob ? fs.readFileSync(path.join(versionDir, blob), 'utf8').replaceAll('&#34;', '"').replaceAll('&quot;', '"') : '';
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
    name, type: rec.info.ContentType || 'Text', version, effectiveDate: rec.effectiveDate || '', description: rec.info.Desc || (conditionalDetails.length ? `Conditional container for ${conditionalDetails.length} alternate content block${conditionalDetails.length === 1 ? '' : 's'}.` : ''),
    fields: [...new Set([...text.matchAll(/\$Data\{[^}]*"Id"\s*:\s*"([^"]+)/g)].map(match => match[1]))],
    conditionals: [...new Set(conditionalDetails.map(item => item.name))],
    conditionalDetails, chart,
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
    return {
      ...(contentCache.get(name) || contentCache.set(name, contentDetails(name, contents, chartsByUuid)).get(name)),
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

function renderHtml(model) {
  const json = JSON.stringify(model).replaceAll('</script>', '<\\/script>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(model.document.name)} inspector</title><style>body{margin:0;font:14px system-ui;color:#172534;background:#f4f7f8}header{padding:14px 22px;background:#fff;border-bottom:1px solid #ccd7dc}main{display:grid;grid-template-columns:minmax(340px,1fr) minmax(420px,1fr);gap:18px;padding:18px}.paper,.inspector{background:#fff;border:1px solid #9eb1ba;padding:16px}.node{margin:10px 0;padding:10px;border:1px solid #2185b7;background:#e9f8fc;cursor:pointer}.node .node{border-color:#c89322;background:#fffbed}.node b{display:block}.muted{color:#5e6f7b;font-size:12px}.chips button,button{border:1px solid #79a6bb;background:#eef9fc;color:#075b86;border-radius:3px;padding:3px 7px;margin:3px;cursor:pointer}#detail{position:sticky;top:12px}.section{border-top:1px solid #d6e0e5;margin-top:12px;padding-top:10px}ul{padding-left:20px}dialog{max-width:780px;width:80%}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><header><b>${esc(model.document.name)}</b> <span class="muted">latest cached version ${esc(model.document.version)}</span></header><main><section class="paper"><h2>Document</h2><p class="muted">Scaled structure approximation — select a region to inspect.</p><div id="tree"></div></section><aside class="inspector" id="detail">Select a region.</aside></main><dialog id="condition"><button onclick="this.closest('dialog').close()">Close</button><h2>Document condition</h2><pre></pre></dialog><script>const model=${json};const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const byName=new Map;function tree(n){byName.set(n.name,n);return '<div class="node" data-node="'+esc(n.name)+'"><b>'+esc(n.name)+'</b><span class="muted">'+esc(n.type||'Layout')+'</span>'+n.children.map(tree).join('')+'</div>'}document.querySelector('#tree').innerHTML=model.layouts.map(tree).join('');function effective(n,seen=new Set){if(seen.has(n.name))return [];seen.add(n.name);return [...new Set([...(n.fields||[]),...n.conditionals.flatMap(name=>effective(model.content[name]||{name,conditionals:[],fields:[]},seen))])]}function show(name){const n=byName.get(name);if(!n)return;const child=n.children.length?'<div class="section"><h3>Child layouts</h3>'+n.children.map(x=>'<button data-node="'+esc(x.name)+'">'+esc(x.name)+' '+(x.always?'always':'conditional')+'</button>').join('')+'</div>':'';const items=n.contents.map(x=>'<li><button data-content="'+esc(x.name)+'">'+esc(x.name)+'</button> '+(x.always?'always':'conditional')+'</li>').join('')||'<li>No direct contents</li>';document.querySelector('#detail').innerHTML='<h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'')+'</p>'+child+'<div class="section"><h3>Contents</h3><ul>'+items+'</ul></div>'}function showContent(name){const n=model.content[name]||{name,fields:[],conditionals:[]};document.querySelector('#detail').innerHTML='<h2>'+esc(name)+'</h2><p class="muted">latest cached version '+esc(n.version||'unknown')+'</p><div class="section"><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p></div><div class="section"><h3>Conditionals</h3>'+n.conditionals.map(x=>'<button data-content="'+esc(x)+'">'+esc(x)+'</button>').join('')+'</div><div class="section"><h3>Fields</h3><ul>'+effective(n).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>'}document.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n){e.stopPropagation();show(n.dataset.node)}const c=e.target.closest('[data-content]');if(c)showContent(c.dataset.content)});document.querySelector('header').insertAdjacentHTML('beforeend',model.package?'<button id="pkg">'+esc(model.package.name)+'</button>':'');document.querySelector('#pkg')?.addEventListener('click',()=>{const d=document.querySelector('#condition');d.querySelector('pre').textContent=model.package.condition||'No document condition found.';d.showModal()});</script></body></html>`;
}

function renderInteractiveHtml(model) {
  const shell = `<!doctype html><html><head><meta charset="utf-8"><title>__TITLE__ inspector</title><style>body{margin:0;font:14px system-ui;color:#172534;background:#f4f7f8}header{padding:14px 22px;background:#fff;border-bottom:1px solid #ccd7dc}main{display:grid;grid-template-columns:minmax(280px,.85fr) minmax(300px,.9fr) minmax(320px,1fr);gap:12px;padding:16px}.panel{background:#fff;border:1px solid #9eb1ba;padding:14px;min-height:540px}.node{margin:8px 0;padding:8px;border:1px solid #2185b7;background:#e9f8fc;cursor:pointer}.node .node{border-color:#c89322;background:#fffbed}.node b{display:block}.muted{color:#5e6f7b;font-size:12px}button{border:1px solid #79a6bb;background:#eef9fc;color:#075b86;border-radius:3px;padding:3px 7px;margin:3px;cursor:pointer}.section{border-top:1px solid #d6e0e5;margin-top:12px;padding-top:10px}ul{padding-left:20px}dialog{max-width:780px;width:80%}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><header><b>__TITLE__</b> <span class="muted">__DESCRIPTION__ · latest cached version</span><button id="version">v__VERSION__</button><button id="layouts">__LAYOUT_COUNT__ layouts</button><button id="styles">__STYLE_COUNT__ document styles</button>__PACKAGE_BUTTON__</header><main><section class="panel"><h2>Document</h2><p class="muted">Select an outlined region.</p><div id="tree"></div></section><aside class="panel" id="details">Select an item.</aside><aside class="panel" id="sub">Select an item in the Details panel.</aside></main><dialog id="condition"><button onclick="this.closest('dialog').close()">Close</button><h2>Document condition</h2><pre></pre></dialog><script>const model=__MODEL__;const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const byName=new Map,details=document.querySelector('#details'),sub=document.querySelector('#sub');function tree(n){byName.set(n.name,n);return '<div class="node" data-node="'+esc(n.name)+'"><b>'+esc(n.name)+'</b><span class="muted">'+esc(n.type||'Layout')+'</span>'+n.children.map(tree).join('')+'</div>'}document.querySelector('#tree').innerHTML=model.layouts.map(tree).join('');function effective(n,seen=new Set){if(seen.has(n.name))return [];seen.add(n.name);return [...new Set([...(n.fields||[]),...n.conditionals.flatMap(name=>effective(model.content[name]||{name,conditionals:[],fields:[]},seen))])]}function layoutDetail(name){const n=byName.get(name);if(!n)return;sub.innerHTML='<p class="muted">Layout metadata</p><h2>'+esc(n.name)+'</h2><h3>Type</h3><p>'+esc(n.type)+'</p><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Inclusion</h3><p>'+(n.always===false?'conditional':'always')+'</p>'}function show(name){const n=byName.get(name);if(!n)return;details.innerHTML='<p class="muted">Layout</p><h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'')+'</p><div class="section"><h3>Child layouts</h3>'+n.children.map(x=>'<button data-layout="'+esc(x.name)+'">'+esc(x.name)+'</button>').join('')+'</div><div class="section"><h3>Contents</h3><ul>'+(n.contents.map(x=>'<li><button data-content="'+esc(x.name)+'">'+esc(x.name)+'</button> '+(x.always?'always':'conditional')+'</li>').join('')||'<li>No direct contents</li>')+'</ul></div>';sub.innerHTML='<p class="muted">Select a child layout or content.</p>'}function content(name){const n=model.content[name]||{name,fields:[],conditionals:[]};sub.innerHTML='<p class="muted">Content · latest cached version</p><h2>'+esc(name)+'</h2><button data-content-version="'+esc(name)+'">v'+esc(n.version||'unknown')+'</button><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Conditionals</h3>'+n.conditionals.map(x=>'<button data-content="'+esc(x)+'">'+esc(x)+'</button>').join('')+'<h3>Fields</h3><ul>'+effective(n).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>'}function documentLayouts(){details.innerHTML='<p class="muted">Document layouts</p><h2>'+esc(model.document.name)+'</h2><ul>'+model.layouts.map(x=>'<li><button data-layout="'+esc(x.name)+'">'+esc(x.name)+'</button></li>').join('')+'</ul>';sub.innerHTML='<p class="muted">Select a layout in the Details panel.</p>'}function style(name){const s=model.document.styles.find(x=>x.name===name)||{};sub.innerHTML='<p class="muted">Style metadata</p><h2>'+esc(s.name||name)+'</h2><h3>Description</h3><p>'+esc(s.description||'No description found.')+'</p><h3>Attributes</h3><ul>'+(s.attributes||[]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>'}function documentStyles(){details.innerHTML='<p class="muted">Document styles</p><h2>'+esc(model.document.name)+'</h2><ul>'+model.document.styles.map(x=>'<li><button data-style="'+esc(x.name)+'">'+esc(x.name)+'</button></li>').join('')+'</ul>';sub.innerHTML='<p class="muted">Select a style in the Details panel.</p>'}function version(){details.innerHTML='<p class="muted">Version metadata</p><h2>'+esc(model.document.name)+'</h2><p>v'+esc(model.document.version)+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>';sub.innerHTML='<p class="muted">Version metadata is shown in the Details panel.</p>'}function contentVersion(name){const n=model.content[name]||{};details.innerHTML='<p class="muted">Version metadata</p><h2>'+esc(name)+'</h2><p>v'+esc(n.version||'unknown')+'</p><h3>Configuration ID</h3><p>'+esc(n.configId||'Unknown')+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>'}document.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n){e.stopPropagation();show(n.dataset.node);return}const l=e.target.closest('[data-layout]');if(l){layoutDetail(l.dataset.layout);return}const c=e.target.closest('[data-content]');if(c){content(c.dataset.content);return}const s=e.target.closest('[data-style]');if(s){style(s.dataset.style);return}const v=e.target.closest('[data-content-version]');if(v)contentVersion(v.dataset.contentVersion)});document.querySelector('#version').addEventListener('click',version);document.querySelector('#layouts').addEventListener('click',documentLayouts);document.querySelector('#styles').addEventListener('click',documentStyles);document.querySelector('#pkg')?.addEventListener('click',()=>{const d=document.querySelector('#condition');d.querySelector('pre').textContent=model.package.condition||'No document condition found.';d.showModal()});</script></body></html>`;
  return shell.replaceAll('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>')).replaceAll('__TITLE__', esc(model.document.name)).replaceAll('__DESCRIPTION__', esc(model.document.description)).replaceAll('__VERSION__', esc(model.document.version)).replaceAll('__LAYOUT_COUNT__', String(model.layouts.length)).replaceAll('__STYLE_COUNT__', String(model.document.styles.length)).replace('__PACKAGE_BUTTON__', model.package ? '<button id="pkg">'+esc(model.package.name)+'</button>' : '');
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

function conditionalNavigationScript(model) {
  const shell = `<script>const mockupContent=__CONTENT__;(()=>{const panel=document.querySelector('#content-panel');let stack=[];const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const fields=(name,seen=new Set)=>{if(seen.has(name))return [];seen.add(name);const item=mockupContent[name]||{};return [...new Set([...(item.fields||[]),...(item.conditionals||[]).flatMap(child=>fields(child,seen))])]} ;function render(name){const item=mockupContent[name]||{name,fields:[],conditionals:[],conditionalDetails:[]};const conditions=item.conditionalDetails||item.conditionals.map(target=>({name:target,condition:''}));const conditionalList=conditions.length?'<ul>'+conditions.map(entry=>'<li><button class="content-link" data-mockup-content="'+encodeURIComponent(entry.name)+'">'+esc(entry.name)+'</button>'+(entry.condition?'<span class="chip" title="Conditional inclusion"> '+esc(entry.condition)+'</span>':'')+'</li>').join('')+'</ul>':'<p>No conditional content references found in this blob.</p>';const back=stack.length>1?'<button class="content-link" data-mockup-back="true">← '+esc(stack[stack.length-2])+'</button>':'';panel.innerHTML='<p class="path">Content</p>'+back+'<h2>'+esc(name)+'</h2><div class="chips"><button class="chip" data-kind="content-version" data-value="'+encodeURIComponent(name)+'">v'+esc(item.version||'unknown')+'</button></div><h3>Description</h3><p>'+esc(item.description||'No description found.')+'</p><h3>Conditionals</h3>'+conditionalList+'<h3>Fields</h3><ul>'+fields(name).map(field=>'<li><button class="content-link" data-field="'+encodeURIComponent(field)+'">'+esc(field)+'</button></li>').join('')+'</ul>'}document.addEventListener('click',event=>{const back=event.target.closest('[data-mockup-back]');if(back){event.preventDefault();event.stopImmediatePropagation();stack.pop();render(stack.at(-1));return}const child=event.target.closest('[data-mockup-content]');if(child){event.preventDefault();event.stopImmediatePropagation();stack.push(decodeURIComponent(child.dataset.mockupContent));render(stack.at(-1));return}const initial=event.target.closest('[data-kind="content"]');if(initial){event.preventDefault();event.stopImmediatePropagation();stack=[decodeURIComponent(initial.dataset.value)];render(stack[0])}},true)})();</script>`;
  return shell.replace('__CONTENT__', JSON.stringify(model.content).replaceAll('</script>', '<\\/script>'));
}

// Content fields may be defined inside a layout-specific iterator rather than
// AssemblyTemplate.Fields. Resolve from the selected layout/content first so
// common field names remain unambiguous.
function iterationFieldScript(model) {
  const shell = `<script>(()=>{const mockupModel=__MODEL__;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const findNode=(nodes,id,prefix='layout')=>{for(let i=0;i<nodes.length;i+=1){const key=prefix+'-'+i,node=nodes[i];if(key===id)return node;const child=findNode(node.children||[],id,key);if(child)return child}return null};const bindingFor=name=>{const id=document.querySelector('.region.selected')?.dataset.node;const layout=id?findNode(mockupModel.layouts,id):null;const direct=(layout?.contents||[]).find(item=>item.name===name)?.binding;if(direct)return direct;const candidates=mockupModel.package?.bindingsByContent?.[name]||[];return candidates.length===1?candidates[0]:candidates[0]||null};const showField=(name)=>{const binding=bindingFor(document.querySelector('#content-panel h2')?.textContent||'');const iterationField=(binding?.iteration?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const topLevel=(mockupModel.package?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const field=iterationField||topLevel||{};const iteration=binding?.iteration;document.querySelector('#field-title').textContent=name;document.querySelector('#field-detail').innerHTML=iteration?'<h3>Iteration</h3><p>'+esc(iteration.id||'Unnamed iterator')+(iteration.type?' · '+esc(iteration.type):'')+'</p><h3>Iteration path</h3><p>'+esc(iteration.path||'No iteration path found.')+'</p>' +(binding.condition?'<h3>Content condition</h3><p>'+esc(binding.condition)+'</p>':'')+'<h3>Field path</h3><p>'+esc(field.Path||'No field path found.')+'</p>':'<h3>Assembly template</h3><p>'+esc(field.Path||'No top-level field definition found.')+'</p>';document.querySelector('#field-dialog').showModal()};document.addEventListener('click',event=>{const target=event.target.closest('[data-field]');if(!target)return;event.preventDefault();event.stopImmediatePropagation();showField(decodeURIComponent(target.dataset.field))},true)})();</script>`;
  return shell.replace('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>'));
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
</style><script>(()=>{
const m=__MODEL__,inspector=document.querySelector('#detail'),content=document.querySelector('#content-detail'),fieldPanel=document.querySelector('#content-panel');
let selected='document',trail=[];const byId=new Map();
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const button=(kind,value,label)=>'<button class="content-link" data-canonical="'+kind+'" data-value="'+encodeURIComponent(value)+'">'+esc(label||value)+'</button>';
const index=(node,id)=>{node.id=id;byId.set(id,node);node.children.forEach((child,i)=>index(child,id+'-'+i))};m.layouts.forEach((node,i)=>index(node,'layout-'+i));
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
function clearDetailPanels(){content.innerHTML='<p class="empty">Choose Contents, Styles, or Child layouts in the Inspector.</p>';fieldPanel.innerHTML='<p class="empty">Choose a field in Content details.</p>';trail=[]}
function packageContext(){content.innerHTML='<p class="path">Details panel › Package context</p><h2>'+esc(m.package?.name||'No package')+'</h2><p>'+esc(m.package?.description||'No package description found.')+'</p><div class="chips"><span class="chip">v'+esc(m.package?.version||'unknown')+'</span><button class="chip trigger off" data-canonical="package-condition" data-value="open">conditional</button></div><h3>Document condition</h3><p>This Assembly Template expression decides whether this document is included. '+button('package-condition','open','Open full condition')+'</p>';fieldPanel.innerHTML='<p class="empty">Select a content in the Details panel.</p>'}
function showInspector(id){const node=id==='document'?documentNode:byId.get(id);if(!node)return;selected=id;document.querySelectorAll('.selected').forEach(el=>el.classList.remove('selected'));document.querySelector('[data-node="'+id+'"]').classList.add('selected');const children=node.children.length,contents=node.contents.length,styles=node.styles.length;const layoutLabel=id==='document'?children+' layouts':children+' child layouts';const styleLabel=id==='document'?styles+' document styles':styles+' styles';const conditionDetail=node.condition?'<p class="inspector-row">'+esc(node.condition)+'</p>':node.always==='never'?'<p class="inspector-row">No Assembly Template condition found.</p>':'';inspector.innerHTML='<p class="path">'+(id==='document'?'Document':'Document › '+esc(node.name))+'</p><h2>'+esc(node.name)+'</h2><p>'+esc(node.description||'No description found.')+'</p><p class="inspector-row">'+button('version',id,'Version '+m.document.version)+'</p><p class="inspector-row"><strong>Condition:</strong> '+trigger(node.always)+'</p>'+conditionDetail+'<p class="inspector-row"><strong>Layouts:</strong> '+button('layouts',id,layoutLabel)+'</p><p class="inspector-row"><strong>Contents:</strong> '+button('contents',id,contents+' contents')+'</p><p class="inspector-row"><strong>Styles:</strong> '+button('styles',id,styleLabel)+'</p>'+(id==='document'?'<p class="inspector-row"><strong>Package:</strong> '+button('package','open',m.package?.name||'No package')+'</p><p class="inspector-row"><strong>Generated:</strong> '+esc(m.generatedLabel||m.generatedAt||'Unknown')+'</p>':'');if(id==='document')packageContext();else clearDetailPanels()}
function listContents(node){content.innerHTML='<p class="path">Content details › Contents</p><h2>'+esc(node.name)+'</h2><h3>Contents</h3>'+(node.contents.length?'<ul>'+node.contents.map(item=>'<li>'+button('content',item.name,(item.chart?'[Chart] ':'')+item.name)+' '+trigger(item.always)+(item.binding?.condition?'<span class="chip" title="Assembly Template condition"> '+esc(item.binding.condition)+'</span>':'')+'</li>').join('')+'</ul>':'<p>No direct contents.</p>');fieldPanel.innerHTML='<p class="empty">Choose a content in Content details.</p>'}
function listStyles(node){content.innerHTML='<p class="path">Content details › Styles</p><h2>'+esc(node.name)+'</h2><h3>Applied styles</h3>'+(node.styles.length?'<ul>'+node.styles.map(item=>'<li>'+button('style',item.name,item.name)+'</li>').join('')+'</ul>':'<p>No applied styles.</p>');fieldPanel.innerHTML='<p class="empty">Select a style to see its attributes.</p>'}
function listLayouts(node){content.innerHTML='<p class="path">Content details › Child layouts</p><h2>'+esc(node.name)+'</h2><h3>Child layouts</h3>'+(node.children.length?'<ul>'+node.children.map(item=>'<li>'+button('layout',item.id,item.name)+' '+trigger(item.always)+'</li>').join('')+'</ul>':'<p>No child layouts.</p>');fieldPanel.innerHTML='<p class="empty">Select a child layout to inspect it.</p>'}
function showContent(name,push=true){const item=m.content[name]||{name,fields:[],conditionals:[],conditionalDetails:[]};const active=trail.at(-1);if(push)trail.push({name,binding:bindingFor(name)});const conditions=item.conditionalDetails||item.conditionals.map(target=>({name:target,condition:''}));const back=trail.length>1?button('back','', '← '+trail.at(-2).name):'';const chartInfo=item.chart?'<h3>Chart placeholder</h3><p><strong>Chart configuration:</strong> '+esc(item.chart.name||'Unresolved chart')+'</p><p>'+esc(item.chart.description||'No chart description found.')+'</p><p><strong>Chart group:</strong> '+esc(item.chart.group||'Unknown')+'</p><p><strong>Chart version:</strong> '+esc(item.chart.version||'Unknown')+' / '+esc(item.chart.seriesCount||0)+' series / '+esc(item.chart.annotationCount||0)+' annotations</p>'+(item.chart.missing?'<p>Referenced chart configuration is not present in the cache.</p>':''):'';content.innerHTML='<p class="path">Content details</p>'+back+'<h2>'+esc(name)+'</h2><div class="chips">'+button('content-version',name,'v'+esc(item.version||'unknown'))+'</div><h3>Description</h3><p>'+esc(item.description||'No description found.')+'</p>'+chartInfo+'<h3>Conditionals</h3>'+(conditions.length?'<ul>'+conditions.map(item=>'<li>'+button('content',item.name,item.name)+(item.condition?'<span class="chip"> '+esc(item.condition)+'</span>':'')+'</li>').join('')+'</ul>':'<p>No conditional content references found.</p>')+'<h3>Fields</h3>'+(fields(name).length?'<ul>'+fields(name).map(item=>'<li>'+button('field',item,item)+'</li>').join('')+'</ul>':'<p>No fields found.</p>');fieldPanel.innerHTML='<p class="empty">Choose a field in Content details.</p>'}
function showField(name){const current=trail.at(-1),binding=bindingForField(current?.name||'',name)||current?.binding||bindingFor(current?.name||'');const iteratorField=(binding?.iteration?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const top=(m.package?.fields||[]).find(item=>(item.Name||item['$$Id'])===name);const value=iteratorField||top||{};const iteration=binding?.iteration;fieldPanel.innerHTML='<p class="path">Field details</p><h2>'+esc(name)+'</h2>'+(iteration?'<h3>Iteration</h3><p>'+esc(iteration.id||'Unnamed iterator')+(iteration.type?' · '+esc(iteration.type):'')+'</p><h3>Iteration path</h3><p>'+esc(iteration.path||'No iteration path found.')+'</p>'+(binding.condition?'<h3>Content condition</h3><p>'+esc(binding.condition)+'</p>':''):'<h3>Assembly template</h3><p>Top-level field definition.</p>')+'<h3>Field path</h3><p>'+esc(value.Path||'No field definition found.')+'</p>'}
function showStyle(name){const node=byId.get(selected),style=(node?.styles||[]).find(item=>item.name===name)||m.document.styles.find(item=>item.name===name)||{};fieldPanel.innerHTML='<p class="path">Style details</p><h2>'+esc(style.name||name)+'</h2><h3>Attributes</h3>'+((style.attributes||[]).length?'<ul>'+style.attributes.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul>':'<p>No attributes recorded.</p>')}
function showVersion(value,fromContent=false){const item=value==='document'?m.document:m.content[value]||byId.get(value)||{};const back=fromContent?button('content-version-back',value,'← '+(item.name||value)):'';const effective=item.effectiveDate?'<h3>Effective date</h3><p>'+esc(item.effectiveDate)+'</p>':'';content.innerHTML='<p class="path">Content details › Version metadata</p>'+back+'<h2>'+esc(item.name||value)+'</h2><h3>Version</h3><p>v'+esc(item.version||m.document.version||'unknown')+'</p>'+effective;fieldPanel.innerHTML='<p class="empty">Version metadata is shown in Content details.</p>'}
document.addEventListener('click',event=>{const node=event.target.closest('[data-node]');if(node){event.preventDefault();event.stopImmediatePropagation();showInspector(node.dataset.node);return}const action=event.target.closest('[data-canonical]');if(!action)return;event.preventDefault();event.stopImmediatePropagation();const kind=action.dataset.canonical,value=decodeURIComponent(action.dataset.value||'');const nodeForAction=value==='document'?documentNode:byId.get(value)||byId.get(selected);if(kind==='contents')listContents(nodeForAction);else if(kind==='styles')listStyles(nodeForAction);else if(kind==='layouts')listLayouts(nodeForAction);else if(kind==='layout')showInspector(value);else if(kind==='content')showContent(value,true);else if(kind==='back'){trail.pop();showContent(trail.at(-1).name,false)}else if(kind==='field')showField(value);else if(kind==='style')showStyle(value);else if(kind==='version')showVersion(value);else if(kind==='content-version')showVersion(value,true);else if(kind==='content-version-back')showContent(value,false);else if(kind==='package'||kind==='package-condition')document.querySelector('#package-dialog').showModal()},true);
document.querySelector('#close')?.addEventListener('click',()=>{inspector.innerHTML='<p class="empty">Select a document region to inspect it.</p>';clearDetailPanels()});showInspector(selected);
})();</script>`;
  return shell.replace('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>'));
}

function renderMockupHtml(model) {
  const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>__TITLE__ document inspector</title><style>
#comms-inspector{color:#18232d;font-family:ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:minmax(480px,560px) minmax(380px,1fr);gap:18px;min-height:680px}.toolbar{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 12px}.toolbar strong{font-size:18px;margin-right:10px}.toolbar span,.hint,.path{color:#63717c;font-size:12px}.stage{overflow:auto;min-height:620px;padding:8px 14px 22px;background:#edf1f3;display:grid;place-items:start center}.page{width:min(100%,520px);min-height:680px;border:1px solid #80909b;background:#fff;box-shadow:0 5px 18px #0002;padding:32px 10px 12px;box-sizing:border-box}.page-title{font-size:11px;font-weight:750}.region{border:1px solid #5d93aa;background:#dff4fa96;color:#15303d;padding:6px;margin:8px 0;box-sizing:border-box;cursor:pointer}.region.child{background:#fff9e8cc;border-color:#b99b55;margin:7px 0 0}.region b,.region small{display:block;pointer-events:none}.region b{font-size:10px}.region small{font-size:8px;line-height:1.2;margin-top:2px;color:#3b6475}.region:hover,.region.selected{outline:3px solid #e36c2e;outline-offset:1px}.inspector{border:1px solid #cdd7dc;background:#fff;align-self:start;position:sticky;top:10px}.inspector-heading{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #d8e0e4;font-weight:700}#close,#package-info{background:none;color:inherit;border:0}#close{font-size:22px}#package-info{color:#20576d;font-size:12px;font-weight:650}#detail,#content-detail,#content-panel{padding:14px}#detail{max-height:220px;overflow:auto}#content-detail{border-top:1px solid #d8e0e4;min-height:120px}#content-panel{border-top:1px solid #d8e0e4;min-height:210px;max-height:330px;overflow:auto}h2{font-size:18px;margin:0 0 5px}h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#63717c;margin:19px 0 7px}p{margin:4px 0;font-size:13px;line-height:1.45}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{font-size:11px;padding:3px 7px;border-radius:999px;background:#e5f4f8;color:#285060;border:0}ul{margin:5px 0;padding-left:18px}li{font-size:12px;line-height:1.55}.empty{color:#63717c;padding:24px 6px}.content-link{border:0;background:none;color:#145b78;padding:0;text-align:left;text-decoration:underline;cursor:pointer}.trigger{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:8px;font-size:10px;line-height:1.25;color:#245b3d;background:#e5f5ea}.trigger.off{color:#8c3030;background:#fbe8e8}dialog{width:min(900px,calc(100vw - 40px));max-height:80vh;border:1px solid #b7c6cc;padding:24px}dialog::backdrop{background:#0008}dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.4;background:#f1f5f6;padding:12px;max-height:42vh;overflow:auto}@media(max-width:900px){#comms-inspector{grid-template-columns:1fr}.inspector{position:static}.stage{min-height:0}}
</style></head><body><main id="comms-inspector"><section class="workspace"><header class="toolbar"><div><strong>__TITLE__</strong><span>__DESCRIPTION__ · version __VERSION__</span></div><div class="hint">Select any outlined region</div></header><div class="stage"><div class="page" id="page"><span class="page-title">__TITLE__</span><div id="document-map"></div></div></div></section><aside class="inspector"><div class="inspector-heading"><span>Inspector</span><span>__PACKAGE_BUTTON__<button id="close" title="Clear selection">×</button></span></div><div id="detail"></div><section id="content-detail"></section><section id="content-panel"></section></aside></main><dialog id="package-dialog"><form method="dialog"><button>Close</button></form><p class="path">Package context</p><h2>__TITLE__ package binding</h2><div id="package-summary"></div><h3>Document trigger condition</h3><pre id="package-condition"></pre></dialog><dialog id="field-dialog"><form method="dialog"><button>Close</button></form><p class="path">Field details</p><h2 id="field-title"></h2><div id="field-detail"></div></dialog><script>
(()=>{const model=__MODEL__,detail=document.querySelector('#detail'),details=document.querySelector('#content-detail'),content=document.querySelector('#content-panel'),byId=new Map;let selected=null;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const button=(kind,value,label)=>'<button class="content-link" data-kind="'+kind+'" data-value="'+encodeURIComponent(value)+'">'+esc(label||value)+'</button>';function index(node,id){node.id=id;byId.set(id,node);node.children.forEach((child,i)=>index(child,id+'-'+i))}model.layouts.forEach((node,i)=>index(node,'layout-'+i));function draw(node){return '<div class="region" data-node="'+node.id+'"><b>'+esc(node.name)+'</b><small>'+esc(node.type)+' · '+node.contents.length+' contents</small>'+node.children.map(draw).join('')+'</div>'}document.querySelector('#document-map').innerHTML=model.layouts.map(draw).join('');function state(value){return value===false?'<span class="trigger off">conditional</span>':'<span class="trigger">always</span>'}function effective(name,seen=new Set){if(seen.has(name))return [];seen.add(name);const item=model.content[name]||{};return [...new Set([...(item.fields||[]),...(item.conditionals||[]).flatMap(child=>effective(child,seen))])]}function showNode(id){const n=byId.get(id);if(!n)return;selected=id;document.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));document.querySelector('[data-node="'+id+'"]')?.classList.add('selected');const chips=['Version '+model.document.version,n.children.length+' child layouts',n.contents.length+' contents',n.styles.length+' styles'];detail.innerHTML='<p class="path">Document › '+esc(n.name)+'</p><h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'No description found.')+'</p><div class="chips">'+chips.map(x=>'<button class="chip" data-kind="meta" data-value="'+encodeURIComponent(x)+'">'+esc(x)+'</button>').join('')+'</div><h3>Inclusion</h3>'+state(n.always)+'<h3>Contents</h3>'+button('collection','contents',n.contents.length+' contents')+'<h3>Applied styles</h3>'+button('collection','styles',n.styles.length+' styles');details.innerHTML='<p class="empty">Select a contents, styles, or child-layout count above.</p>';content.innerHTML='<p class="empty">Select an item in the Details panel.</p>'}function list(items,kind){return items.length?'<ul>'+items.map(item=>'<li>'+button(kind,typeof item==='string'?item:item.name)+(item.always===undefined?'':state(item.always))+'</li>').join('')+'</ul>':'<p>No items found.</p>'}function showCollection(kind){const n=byId.get(selected);if(!n)return;if(kind==='layouts'){details.innerHTML='<p class="path">Details panel › Child layouts</p><h2>'+esc(n.name)+'</h2>'+list(n.children.map(x=>({name:x.id,always:x.always})), 'layout');return}if(kind==='contents'){details.innerHTML='<p class="path">Details panel › Contents</p><h2>'+esc(n.name)+'</h2>'+list(n.contents,'content');return}details.innerHTML='<p class="path">Details panel › Styles</p><h2>'+esc(n.name)+'</h2>'+list(n.styles,'style')}function showLayout(id){const n=byId.get(id);if(!n)return;content.innerHTML='<p class="path">Layout</p><h2>'+esc(n.name)+'</h2><h3>Type</h3><p>'+esc(n.type)+'</p><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Contents</h3><p>'+n.contents.length+' direct contents.</p>'}function showStyle(name){const n=byId.get(selected),style=(n?.styles||[]).find(x=>x.name===name)||{};content.innerHTML='<p class="path">Style</p><h2>'+esc(style.name||name)+'</h2><h3>Description</h3><p>'+esc(style.description||'No description found.')+'</p><h3>Attributes</h3>'+list(style.attributes||[],'none')}function showContent(name){const item=model.content[name]||{name,fields:[],conditionals:[]};content.innerHTML='<p class="path">Content</p><h2>'+esc(name)+'</h2><div class="chips"><button class="chip" data-kind="content-version" data-value="'+encodeURIComponent(name)+'">v'+esc(item.version||'unknown')+'</button></div><h3>Description</h3><p>'+esc(item.description||'No description found.')+'</p><h3>Conditionals</h3>'+list(item.conditionals||[],'content')+'<h3>Fields</h3><ul>'+effective(name).map(field=>'<li><button class="content-link" data-field="'+encodeURIComponent(field)+'">'+esc(field)+'</button></li>').join('')+'</ul>'}function version(name){const item=name?model.content[name]:model.document;details.innerHTML='<p class="path">Details panel › Version metadata</p><h2>'+esc(item.name||name)+'</h2><h3>Version</h3><p>v'+esc(item.version||'unknown')+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>'}function documentList(kind){if(kind==='layouts'){details.innerHTML='<p class="path">Details panel › Document layouts</p><h2>'+esc(model.document.name)+'</h2>'+list(model.layouts.map(x=>({name:x.id,always:x.always})),'layout')}else details.innerHTML='<p class="path">Details panel › Document styles</p><h2>'+esc(model.document.name)+'</h2>'+list(model.document.styles,'document-style')}function field(name){const item=(model.package?.fields||[]).find(x=>(x.Name||x['$$Id'])===name)||{};document.querySelector('#field-title').textContent=name;document.querySelector('#field-detail').innerHTML='<h3>Assembly template</h3><p>'+esc(item.Path||'No top-level field definition found.')+'</p>';document.querySelector('#field-dialog').showModal()}document.addEventListener('click',e=>{const node=e.target.closest('[data-node]');if(node){e.stopPropagation();showNode(node.dataset.node);return}const el=e.target.closest('[data-kind]');if(el){const kind=el.dataset.kind,value=decodeURIComponent(el.dataset.value);if(kind==='collection')showCollection(value);else if(kind==='layout')showLayout(value);else if(kind==='content')showContent(value);else if(kind==='style')showStyle(value);else if(kind==='document-style'){const s=model.document.styles.find(x=>x.name===value)||{};content.innerHTML='<p class="path">Style</p><h2>'+esc(s.name)+'</h2><h3>Attributes</h3>'+list(s.attributes||[],'none')}else if(kind==='content-version')version(value);else if(kind==='meta'){if(/child layouts/.test(value))showCollection('layouts');else if(/contents/.test(value))showCollection('contents');else if(/styles/.test(value))showCollection('styles');else if(/Version/.test(value))version()}}const f=e.target.closest('[data-field]');if(f)field(decodeURIComponent(f.dataset.field))});document.querySelector('#close').addEventListener('click',()=>{selected=null;detail.innerHTML='<p class="empty">Select a document region to inspect its cached relationships, contents, and styles.</p>';details.innerHTML='<p class="empty">Select a content or style count above.</p>';content.innerHTML='<p class="empty">Select an item in the Details panel.</p>'});document.querySelector('#package-info')?.addEventListener('click',()=>document.querySelector('#package-dialog').showModal());document.querySelector('#package-summary').innerHTML=model.package?'<div class="chips"><span class="chip">'+model.package.fields.length+' package fields</span></div>':'<p>No package context.</p>';document.querySelector('#package-condition').textContent=model.package?.condition||'No document condition found.';content.innerHTML='<p class="empty">Select a document region.</p>';showNode(model.layouts[0].id)})();</script></body></html>`;
  return shell.replace('</style>', gridCss(model.layouts) + '</style>').replace('</body>', canonicalInspectorScript(model) + conditionalNavigationScript(model) + iterationFieldScript(model) + '</body>').replaceAll('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>')).replaceAll('__TITLE__', esc(model.document.name)).replaceAll('__DESCRIPTION__', esc(model.document.description)).replaceAll('__VERSION__', esc(model.document.version)).replaceAll('__PACKAGE_BUTTON__', '');
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
  const documentFile = latestFile(documentDir);
  if (!documentFile) throw new Error(`No cached document versions found for ${documentName} at ${documentDir}. Run get-everything first.`);
  const document = readJson(documentFile);
  const info = document.CommunicationDocumentConfigRec?.CommunicationDocumentConfigInfo || {};
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
    const detail = contentCache.get(name) || contentCache.set(name, contentDetails(name, contents, chartsByUuid)).get(name);
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
  const model = { generatedAt: generatedAt.toISOString(), generatedLabel: generatedTimestamp(generatedAt), cacheDir, document: { name: info.ShortName || documentName, description: info.Desc || '', version: path.basename(documentFile, '.json'), styles: documentStyles }, package: packageInfo, layouts: rootLayouts, content };
  const output = path.resolve(opts.output || path.join(cacheDir, `${documentName}-inspector.html`));
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, renderMockupHtml(model));
  console.log(chalk.green(`Generated ${output}`));
  console.log(chalk.gray(`Latest cached document version: ${model.document.version}`));
}
