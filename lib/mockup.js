import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { ensureDir, stringifyJSON } from './utils.js';

const versionParts = value => (String(value || '').match(/\d+/g) || []).map(Number);
const compareVersions = (a, b) => {
  const aa = versionParts(a), bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const latestFile = directory => {
  if (!fs.existsSync(directory)) return null;
  const entries = fs.readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('_expanded.json'));
  if (!entries.length) return null;
  return path.join(directory, entries.sort((a, b) => compareVersions(path.parse(a).name, path.parse(b).name)).at(-1));
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
    const info = readJson(path.join(dir, config)).CommunicationContentConfigInfo || {};
    index.set(info.ShortName || folder, { dir, info });
  }
  return index;
}

function contentDetails(name, index) {
  const rec = index.get(name);
  if (!rec) return { name, missing: true, fields: [], conditionals: [] };
  const file = latestFile(path.join(rec.dir, 'versions'));
  if (!file) return { name, description: rec.info.Desc || '', fields: [], conditionals: [] };
  const version = path.basename(file, '.json');
  const blob = fs.readdirSync(path.dirname(file)).find(item => item.endsWith('.blob'));
  const text = blob ? fs.readFileSync(path.join(path.dirname(file), blob), 'utf8').replaceAll('&#34;', '"').replaceAll('&quot;', '"') : '';
  return {
    name, version, description: rec.info.Desc || '',
    fields: [...new Set([...text.matchAll(/\$Data\{[^}]*"Id":"([^"]+)/g)].map(match => match[1]))],
    conditionals: [...new Set([...text.matchAll(/\$Cond\{[^}]*"Content":"([^"]+)/g)].map(match => match[1]))],
  };
}

function walkLayout(uuid, layouts, contents, seen = new Set()) {
  if (seen.has(uuid)) return { name: '(cycle)', children: [] };
  seen.add(uuid);
  const entry = layouts.get(uuid);
  if (!entry) return { name: '(unresolved layout)', children: [] };
  const data = entry.data;
  const relations = (data.CommunicationLayoutContents || []).map(item => {
    const relation = item.CommunicationLayoutConfigCommunicationContentConfigRelRec?.CommunicationLayoutConfigCommunicationContentConfigRelInfo || {};
    return { ...contentDetails(item.ShortName, contents), always: relation.ContentAlwaysTriggerInd === true };
  });
  const children = (data.CommunicationLayoutLayouts || []).map(item => {
    const relation = item.CommunicationLayoutConfigCommunicationLayoutConfigRelRec?.CommunicationLayoutConfigCommunicationLayoutConfigRelInfo || {};
    return { ...walkLayout(relation.RelCommunicationLayoutConfigUuid, layouts, contents, new Set(seen)), always: relation.LayoutAlwaysTriggerInd === true, area: relation.StyleAreaName || '' };
  });
  const info = data.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo || {};
  return { name: entry.name, type: info.LayoutType || 'Layout', description: info.Desc || '', contents: relations, children };
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
  return { name: packageName, version, description: assembly.Desc || '', condition: doc?.Condition || '', fields: assembly.Fields || [] };
}

function renderHtml(model) {
  const json = JSON.stringify(model).replaceAll('</script>', '<\\/script>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(model.document.name)} inspector</title><style>body{margin:0;font:14px system-ui;color:#172534;background:#f4f7f8}header{padding:14px 22px;background:#fff;border-bottom:1px solid #ccd7dc}main{display:grid;grid-template-columns:minmax(340px,1fr) minmax(420px,1fr);gap:18px;padding:18px}.paper,.inspector{background:#fff;border:1px solid #9eb1ba;padding:16px}.node{margin:10px 0;padding:10px;border:1px solid #2185b7;background:#e9f8fc;cursor:pointer}.node .node{border-color:#c89322;background:#fffbed}.node b{display:block}.muted{color:#5e6f7b;font-size:12px}.chips button,button{border:1px solid #79a6bb;background:#eef9fc;color:#075b86;border-radius:3px;padding:3px 7px;margin:3px;cursor:pointer}#detail{position:sticky;top:12px}.section{border-top:1px solid #d6e0e5;margin-top:12px;padding-top:10px}ul{padding-left:20px}dialog{max-width:780px;width:80%}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><header><b>${esc(model.document.name)}</b> <span class="muted">latest cached version ${esc(model.document.version)}</span></header><main><section class="paper"><h2>Document</h2><p class="muted">Scaled structure approximation — select a region to inspect.</p><div id="tree"></div></section><aside class="inspector" id="detail">Select a region.</aside></main><dialog id="condition"><button onclick="this.closest('dialog').close()">Close</button><h2>Document condition</h2><pre></pre></dialog><script>const model=${json};const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const byName=new Map;function tree(n){byName.set(n.name,n);return '<div class="node" data-node="'+esc(n.name)+'"><b>'+esc(n.name)+'</b><span class="muted">'+esc(n.type||'Layout')+'</span>'+n.children.map(tree).join('')+'</div>'}document.querySelector('#tree').innerHTML=model.layouts.map(tree).join('');function effective(n,seen=new Set){if(seen.has(n.name))return [];seen.add(n.name);return [...new Set([...(n.fields||[]),...n.conditionals.flatMap(name=>effective(model.content[name]||{name,conditionals:[],fields:[]},seen))])]}function show(name){const n=byName.get(name);if(!n)return;const child=n.children.length?'<div class="section"><h3>Child layouts</h3>'+n.children.map(x=>'<button data-node="'+esc(x.name)+'">'+esc(x.name)+' '+(x.always?'always':'conditional')+'</button>').join('')+'</div>':'';const items=n.contents.map(x=>'<li><button data-content="'+esc(x.name)+'">'+esc(x.name)+'</button> '+(x.always?'always':'conditional')+'</li>').join('')||'<li>No direct contents</li>';document.querySelector('#detail').innerHTML='<h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'')+'</p>'+child+'<div class="section"><h3>Contents</h3><ul>'+items+'</ul></div>'}function showContent(name){const n=model.content[name]||{name,fields:[],conditionals:[]};document.querySelector('#detail').innerHTML='<h2>'+esc(name)+'</h2><p class="muted">latest cached version '+esc(n.version||'unknown')+'</p><div class="section"><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p></div><div class="section"><h3>Conditionals</h3>'+n.conditionals.map(x=>'<button data-content="'+esc(x)+'">'+esc(x)+'</button>').join('')+'</div><div class="section"><h3>Fields</h3><ul>'+effective(n).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></div>'}document.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n){e.stopPropagation();show(n.dataset.node)}const c=e.target.closest('[data-content]');if(c)showContent(c.dataset.content)});document.querySelector('header').insertAdjacentHTML('beforeend',model.package?'<button id="pkg">'+esc(model.package.name)+'</button>':'');document.querySelector('#pkg')?.addEventListener('click',()=>{const d=document.querySelector('#condition');d.querySelector('pre').textContent=model.package.condition||'No document condition found.';d.showModal()});</script></body></html>`;
}

export async function mockupCommand(documentName, cmd) {
  const opts = typeof cmd?.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : cmd || {};
  const cacheDir = path.resolve(opts.cache || './comms_cache');
  const documentDir = path.join(cacheDir, 'documents', documentName, 'versions');
  const documentFile = latestFile(documentDir);
  if (!documentFile) throw new Error(`No cached document versions found for ${documentName} at ${documentDir}. Run get-everything first.`);
  const document = readJson(documentFile);
  const info = document.CommunicationDocumentConfigRec?.CommunicationDocumentConfigInfo || {};
  const layouts = layoutIndex(cacheDir), contents = contentIndex(cacheDir);
  const rootLayouts = (document.CommunicationDocumentVersionLayouts || []).map(item => {
    const relation = item.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelRec?.CommunicationDocumentVersionConfigCommunicationLayoutConfigRelInfo || {};
    return { ...walkLayout(relation.CommunicationLayoutConfigUuid, layouts, contents), always: relation.LayoutAlwaysTriggerInd === true };
  });
  // Keep the standalone artifact focused: include only content reachable from the
  // selected document, including transitive <comms-cond> content references.
  const selectedContent = new Map();
  const addContent = name => {
    if (selectedContent.has(name)) return;
    const detail = contentDetails(name, contents);
    selectedContent.set(name, detail);
    detail.conditionals.forEach(addContent);
  };
  const collectLayoutContent = layout => {
    layout.contents.forEach(item => addContent(item.name));
    layout.children.forEach(collectLayoutContent);
  };
  rootLayouts.forEach(collectLayoutContent);
  const content = Object.fromEntries(selectedContent);
  const model = { generatedAt: new Date().toISOString(), cacheDir, document: { name: info.ShortName || documentName, description: info.Desc || '', version: path.basename(documentFile, '.json') }, package: packageContext(cacheDir, opts.package, info.ShortName || documentName), layouts: rootLayouts, content };
  const output = path.resolve(opts.output || path.join(cacheDir, `${documentName}-inspector.html`));
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, renderHtml(model));
  fs.writeFileSync(output.replace(/\.html$/i, '.json'), stringifyJSON(model));
  console.log(chalk.green(`Generated ${output}`));
  console.log(chalk.gray(`Latest cached document version: ${model.document.version}`));
}
