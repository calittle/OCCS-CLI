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
  const styles = (data.CommunicationLayoutStyles || []).map(item => {
    const style = item.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    const attributes = style.CommunicationStyleConfigStyleAttribute?.Items || [];
    return {
      name: style.ShortName || style.Name || item.ShortName || 'Unnamed style',
      description: style.Desc || '',
      attributes: attributes.map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || '')),
    };
  });
  const info = data.CommunicationLayoutConfigRec?.CommunicationLayoutConfigInfo || {};
  return { name: entry.name, type: info.LayoutType || 'Layout', description: info.Desc || '', styles, contents: relations, children };
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

function renderInteractiveHtml(model) {
  const shell = `<!doctype html><html><head><meta charset="utf-8"><title>__TITLE__ inspector</title><style>body{margin:0;font:14px system-ui;color:#172534;background:#f4f7f8}header{padding:14px 22px;background:#fff;border-bottom:1px solid #ccd7dc}main{display:grid;grid-template-columns:minmax(280px,.85fr) minmax(300px,.9fr) minmax(320px,1fr);gap:12px;padding:16px}.panel{background:#fff;border:1px solid #9eb1ba;padding:14px;min-height:540px}.node{margin:8px 0;padding:8px;border:1px solid #2185b7;background:#e9f8fc;cursor:pointer}.node .node{border-color:#c89322;background:#fffbed}.node b{display:block}.muted{color:#5e6f7b;font-size:12px}button{border:1px solid #79a6bb;background:#eef9fc;color:#075b86;border-radius:3px;padding:3px 7px;margin:3px;cursor:pointer}.section{border-top:1px solid #d6e0e5;margin-top:12px;padding-top:10px}ul{padding-left:20px}dialog{max-width:780px;width:80%}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><header><b>__TITLE__</b> <span class="muted">__DESCRIPTION__ · latest cached version</span><button id="version">v__VERSION__</button><button id="layouts">__LAYOUT_COUNT__ layouts</button><button id="styles">__STYLE_COUNT__ document styles</button>__PACKAGE_BUTTON__</header><main><section class="panel"><h2>Document</h2><p class="muted">Select an outlined region.</p><div id="tree"></div></section><aside class="panel" id="details">Select an item.</aside><aside class="panel" id="sub">Select an item in the Details panel.</aside></main><dialog id="condition"><button onclick="this.closest('dialog').close()">Close</button><h2>Document condition</h2><pre></pre></dialog><script>const model=__MODEL__;const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const byName=new Map,details=document.querySelector('#details'),sub=document.querySelector('#sub');function tree(n){byName.set(n.name,n);return '<div class="node" data-node="'+esc(n.name)+'"><b>'+esc(n.name)+'</b><span class="muted">'+esc(n.type||'Layout')+'</span>'+n.children.map(tree).join('')+'</div>'}document.querySelector('#tree').innerHTML=model.layouts.map(tree).join('');function effective(n,seen=new Set){if(seen.has(n.name))return [];seen.add(n.name);return [...new Set([...(n.fields||[]),...n.conditionals.flatMap(name=>effective(model.content[name]||{name,conditionals:[],fields:[]},seen))])]}function layoutDetail(name){const n=byName.get(name);if(!n)return;sub.innerHTML='<p class="muted">Layout metadata</p><h2>'+esc(n.name)+'</h2><h3>Type</h3><p>'+esc(n.type)+'</p><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Inclusion</h3><p>'+(n.always===false?'conditional':'always')+'</p>'}function show(name){const n=byName.get(name);if(!n)return;details.innerHTML='<p class="muted">Layout</p><h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'')+'</p><div class="section"><h3>Child layouts</h3>'+n.children.map(x=>'<button data-layout="'+esc(x.name)+'">'+esc(x.name)+'</button>').join('')+'</div><div class="section"><h3>Contents</h3><ul>'+(n.contents.map(x=>'<li><button data-content="'+esc(x.name)+'">'+esc(x.name)+'</button> '+(x.always?'always':'conditional')+'</li>').join('')||'<li>No direct contents</li>')+'</ul></div>';sub.innerHTML='<p class="muted">Select a child layout or content.</p>'}function content(name){const n=model.content[name]||{name,fields:[],conditionals:[]};sub.innerHTML='<p class="muted">Content · latest cached version</p><h2>'+esc(name)+'</h2><button data-content-version="'+esc(name)+'">v'+esc(n.version||'unknown')+'</button><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Conditionals</h3>'+n.conditionals.map(x=>'<button data-content="'+esc(x)+'">'+esc(x)+'</button>').join('')+'<h3>Fields</h3><ul>'+effective(n).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>'}function documentLayouts(){details.innerHTML='<p class="muted">Document layouts</p><h2>'+esc(model.document.name)+'</h2><ul>'+model.layouts.map(x=>'<li><button data-layout="'+esc(x.name)+'">'+esc(x.name)+'</button></li>').join('')+'</ul>';sub.innerHTML='<p class="muted">Select a layout in the Details panel.</p>'}function style(name){const s=model.document.styles.find(x=>x.name===name)||{};sub.innerHTML='<p class="muted">Style metadata</p><h2>'+esc(s.name||name)+'</h2><h3>Description</h3><p>'+esc(s.description||'No description found.')+'</p><h3>Attributes</h3><ul>'+(s.attributes||[]).map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>'}function documentStyles(){details.innerHTML='<p class="muted">Document styles</p><h2>'+esc(model.document.name)+'</h2><ul>'+model.document.styles.map(x=>'<li><button data-style="'+esc(x.name)+'">'+esc(x.name)+'</button></li>').join('')+'</ul>';sub.innerHTML='<p class="muted">Select a style in the Details panel.</p>'}function version(){details.innerHTML='<p class="muted">Version metadata</p><h2>'+esc(model.document.name)+'</h2><p>v'+esc(model.document.version)+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>';sub.innerHTML='<p class="muted">Version metadata is shown in the Details panel.</p>'}function contentVersion(name){const n=model.content[name]||{};details.innerHTML='<p class="muted">Version metadata</p><h2>'+esc(name)+'</h2><p>v'+esc(n.version||'unknown')+'</p><h3>Configuration ID</h3><p>'+esc(n.configId||'Unknown')+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>'}document.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n){e.stopPropagation();show(n.dataset.node);return}const l=e.target.closest('[data-layout]');if(l){layoutDetail(l.dataset.layout);return}const c=e.target.closest('[data-content]');if(c){content(c.dataset.content);return}const s=e.target.closest('[data-style]');if(s){style(s.dataset.style);return}const v=e.target.closest('[data-content-version]');if(v)contentVersion(v.dataset.contentVersion)});document.querySelector('#version').addEventListener('click',version);document.querySelector('#layouts').addEventListener('click',documentLayouts);document.querySelector('#styles').addEventListener('click',documentStyles);document.querySelector('#pkg')?.addEventListener('click',()=>{const d=document.querySelector('#condition');d.querySelector('pre').textContent=model.package.condition||'No document condition found.';d.showModal()});</script></body></html>`;
  return shell.replaceAll('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>')).replaceAll('__TITLE__', esc(model.document.name)).replaceAll('__DESCRIPTION__', esc(model.document.description)).replaceAll('__VERSION__', esc(model.document.version)).replaceAll('__LAYOUT_COUNT__', String(model.layouts.length)).replaceAll('__STYLE_COUNT__', String(model.document.styles.length)).replace('__PACKAGE_BUTTON__', model.package ? '<button id="pkg">'+esc(model.package.name)+'</button>' : '');
}

function renderMockupHtml(model) {
  const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>__TITLE__ document inspector</title><style>
#comms-inspector{color:#18232d;font-family:ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:minmax(480px,560px) minmax(380px,1fr);gap:18px;min-height:680px}.toolbar{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 12px}.toolbar strong{font-size:18px;margin-right:10px}.toolbar span,.hint,.path{color:#63717c;font-size:12px}.stage{overflow:auto;min-height:620px;padding:8px 14px 22px;background:#edf1f3;display:grid;place-items:start center}.page{width:min(100%,520px);min-height:680px;border:1px solid #80909b;background:#fff;box-shadow:0 5px 18px #0002;padding:32px 10px 12px;box-sizing:border-box}.page-title{font-size:11px;font-weight:750}.region{border:1px solid #5d93aa;background:#dff4fa96;color:#15303d;padding:6px;margin:8px 0;box-sizing:border-box;cursor:pointer}.region.child{background:#fff9e8cc;border-color:#b99b55;margin:7px 0 0}.region b,.region small{display:block;pointer-events:none}.region b{font-size:10px}.region small{font-size:8px;line-height:1.2;margin-top:2px;color:#3b6475}.region:hover,.region.selected{outline:3px solid #e36c2e;outline-offset:1px}.inspector{border:1px solid #cdd7dc;background:#fff;align-self:start;position:sticky;top:10px}.inspector-heading{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid #d8e0e4;font-weight:700}#close,#package-info{background:none;color:inherit;border:0}#close{font-size:22px}#package-info{color:#20576d;font-size:12px;font-weight:650}#detail,#content-detail,#content-panel{padding:14px}#detail{max-height:220px;overflow:auto}#content-detail{border-top:1px solid #d8e0e4;min-height:120px}#content-panel{border-top:1px solid #d8e0e4;min-height:210px;max-height:330px;overflow:auto}h2{font-size:18px;margin:0 0 5px}h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#63717c;margin:19px 0 7px}p{margin:4px 0;font-size:13px;line-height:1.45}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{font-size:11px;padding:3px 7px;border-radius:999px;background:#e5f4f8;color:#285060;border:0}ul{margin:5px 0;padding-left:18px}li{font-size:12px;line-height:1.55}.empty{color:#63717c;padding:24px 6px}.content-link{border:0;background:none;color:#145b78;padding:0;text-align:left;text-decoration:underline;cursor:pointer}.trigger{display:inline-block;margin-left:6px;padding:1px 5px;border-radius:8px;font-size:10px;line-height:1.25;color:#245b3d;background:#e5f5ea}.trigger.off{color:#8c3030;background:#fbe8e8}dialog{width:min(900px,calc(100vw - 40px));max-height:80vh;border:1px solid #b7c6cc;padding:24px}dialog::backdrop{background:#0008}dialog pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.4;background:#f1f5f6;padding:12px;max-height:42vh;overflow:auto}@media(max-width:900px){#comms-inspector{grid-template-columns:1fr}.inspector{position:static}.stage{min-height:0}}
</style></head><body><main id="comms-inspector"><section class="workspace"><header class="toolbar"><div><strong>__TITLE__</strong><span>__DESCRIPTION__ · version __VERSION__</span></div><div class="hint">Select any outlined region</div></header><div class="stage"><div class="page" id="page"><span class="page-title">__TITLE__</span><div id="document-map"></div></div></div></section><aside class="inspector"><div class="inspector-heading"><span>Inspector</span><span>__PACKAGE_BUTTON__<button id="close" title="Clear selection">×</button></span></div><div id="detail"></div><section id="content-detail"></section><section id="content-panel"></section></aside></main><dialog id="package-dialog"><form method="dialog"><button>Close</button></form><p class="path">Package context</p><h2>__TITLE__ package binding</h2><div id="package-summary"></div><h3>Document trigger condition</h3><pre id="package-condition"></pre></dialog><dialog id="field-dialog"><form method="dialog"><button>Close</button></form><p class="path">Field details</p><h2 id="field-title"></h2><div id="field-detail"></div></dialog><script>
(()=>{const model=__MODEL__,detail=document.querySelector('#detail'),details=document.querySelector('#content-detail'),content=document.querySelector('#content-panel'),byId=new Map;let selected=null;const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');const button=(kind,value,label)=>'<button class="content-link" data-kind="'+kind+'" data-value="'+encodeURIComponent(value)+'">'+esc(label||value)+'</button>';function index(node,id){node.id=id;byId.set(id,node);node.children.forEach((child,i)=>index(child,id+'-'+i))}model.layouts.forEach((node,i)=>index(node,'layout-'+i));function draw(node){return '<div class="region" data-node="'+node.id+'"><b>'+esc(node.name)+'</b><small>'+esc(node.type)+' · '+node.contents.length+' contents</small>'+node.children.map(draw).join('')+'</div>'}document.querySelector('#document-map').innerHTML=model.layouts.map(draw).join('');function state(value){return value===false?'<span class="trigger off">conditional</span>':'<span class="trigger">always</span>'}function effective(name,seen=new Set){if(seen.has(name))return [];seen.add(name);const item=model.content[name]||{};return [...new Set([...(item.fields||[]),...(item.conditionals||[]).flatMap(child=>effective(child,seen))])]}function showNode(id){const n=byId.get(id);if(!n)return;selected=id;document.querySelectorAll('.selected').forEach(x=>x.classList.remove('selected'));document.querySelector('[data-node="'+id+'"]')?.classList.add('selected');const chips=['Version '+model.document.version,n.children.length+' child layouts',n.contents.length+' contents',n.styles.length+' styles'];detail.innerHTML='<p class="path">Document › '+esc(n.name)+'</p><h2>'+esc(n.name)+'</h2><p>'+esc(n.description||'No description found.')+'</p><div class="chips">'+chips.map(x=>'<button class="chip" data-kind="meta" data-value="'+encodeURIComponent(x)+'">'+esc(x)+'</button>').join('')+'</div><h3>Inclusion</h3>'+state(n.always)+'<h3>Contents</h3>'+button('collection','contents',n.contents.length+' contents')+'<h3>Applied styles</h3>'+button('collection','styles',n.styles.length+' styles');details.innerHTML='<p class="empty">Select a contents, styles, or child-layout count above.</p>';content.innerHTML='<p class="empty">Select an item in the Details panel.</p>'}function list(items,kind){return items.length?'<ul>'+items.map(item=>'<li>'+button(kind,typeof item==='string'?item:item.name)+(item.always===undefined?'':state(item.always))+'</li>').join('')+'</ul>':'<p>No items found.</p>'}function showCollection(kind){const n=byId.get(selected);if(!n)return;if(kind==='layouts'){details.innerHTML='<p class="path">Details panel › Child layouts</p><h2>'+esc(n.name)+'</h2>'+list(n.children.map(x=>({name:x.id,always:x.always})), 'layout');return}if(kind==='contents'){details.innerHTML='<p class="path">Details panel › Contents</p><h2>'+esc(n.name)+'</h2>'+list(n.contents,'content');return}details.innerHTML='<p class="path">Details panel › Styles</p><h2>'+esc(n.name)+'</h2>'+list(n.styles,'style')}function showLayout(id){const n=byId.get(id);if(!n)return;content.innerHTML='<p class="path">Layout</p><h2>'+esc(n.name)+'</h2><h3>Type</h3><p>'+esc(n.type)+'</p><h3>Description</h3><p>'+esc(n.description||'No description found.')+'</p><h3>Contents</h3><p>'+n.contents.length+' direct contents.</p>'}function showStyle(name){const n=byId.get(selected),style=(n?.styles||[]).find(x=>x.name===name)||{};content.innerHTML='<p class="path">Style</p><h2>'+esc(style.name||name)+'</h2><h3>Description</h3><p>'+esc(style.description||'No description found.')+'</p><h3>Attributes</h3>'+list(style.attributes||[],'none')}function showContent(name){const item=model.content[name]||{name,fields:[],conditionals:[]};content.innerHTML='<p class="path">Content</p><h2>'+esc(name)+'</h2><div class="chips"><button class="chip" data-kind="content-version" data-value="'+encodeURIComponent(name)+'">v'+esc(item.version||'unknown')+'</button></div><h3>Description</h3><p>'+esc(item.description||'No description found.')+'</p><h3>Conditionals</h3>'+list(item.conditionals||[],'content')+'<h3>Fields</h3><ul>'+effective(name).map(field=>'<li><button class="content-link" data-field="'+encodeURIComponent(field)+'">'+esc(field)+'</button></li>').join('')+'</ul>'}function version(name){const item=name?model.content[name]:model.document;details.innerHTML='<p class="path">Details panel › Version metadata</p><h2>'+esc(item.name||name)+'</h2><h3>Version</h3><p>v'+esc(item.version||'unknown')+'</p><h3>Cache rule</h3><p>Latest available version in the refreshed comms cache.</p>'}function documentList(kind){if(kind==='layouts'){details.innerHTML='<p class="path">Details panel › Document layouts</p><h2>'+esc(model.document.name)+'</h2>'+list(model.layouts.map(x=>({name:x.id,always:x.always})),'layout')}else details.innerHTML='<p class="path">Details panel › Document styles</p><h2>'+esc(model.document.name)+'</h2>'+list(model.document.styles,'document-style')}function field(name){const item=(model.package?.fields||[]).find(x=>(x.Name||x['$$Id'])===name)||{};document.querySelector('#field-title').textContent=name;document.querySelector('#field-detail').innerHTML='<h3>Assembly template</h3><p>'+esc(item.Path||'No top-level field definition found.')+'</p>';document.querySelector('#field-dialog').showModal()}document.addEventListener('click',e=>{const node=e.target.closest('[data-node]');if(node){e.stopPropagation();showNode(node.dataset.node);return}const el=e.target.closest('[data-kind]');if(el){const kind=el.dataset.kind,value=decodeURIComponent(el.dataset.value);if(kind==='collection')showCollection(value);else if(kind==='layout')showLayout(value);else if(kind==='content')showContent(value);else if(kind==='style')showStyle(value);else if(kind==='document-style'){const s=model.document.styles.find(x=>x.name===value)||{};content.innerHTML='<p class="path">Style</p><h2>'+esc(s.name)+'</h2><h3>Attributes</h3>'+list(s.attributes||[],'none')}else if(kind==='content-version')version(value);else if(kind==='meta'){if(/child layouts/.test(value))showCollection('layouts');else if(/contents/.test(value))showCollection('contents');else if(/styles/.test(value))showCollection('styles');else if(/Version/.test(value))version()}}const f=e.target.closest('[data-field]');if(f)field(decodeURIComponent(f.dataset.field))});document.querySelector('#close').addEventListener('click',()=>{selected=null;detail.innerHTML='<p class="empty">Select a document region to inspect its cached relationships, contents, and styles.</p>';details.innerHTML='<p class="empty">Select a content or style count above.</p>';content.innerHTML='<p class="empty">Select an item in the Details panel.</p>'});document.querySelector('#package-info')?.addEventListener('click',()=>document.querySelector('#package-dialog').showModal());document.querySelector('#package-summary').innerHTML=model.package?'<div class="chips"><span class="chip">'+model.package.fields.length+' package fields</span></div>':'<p>No package context.</p>';document.querySelector('#package-condition').textContent=model.package?.condition||'No document condition found.';content.innerHTML='<p class="empty">Select a document region.</p>';showNode(model.layouts[0].id)})();</script></body></html>`;
  return shell.replaceAll('__MODEL__', JSON.stringify(model).replaceAll('</script>', '<\\/script>')).replaceAll('__TITLE__', esc(model.document.name)).replaceAll('__DESCRIPTION__', esc(model.document.description)).replaceAll('__VERSION__', esc(model.document.version)).replaceAll('__PACKAGE_BUTTON__', model.package ? '<button id="package-info">'+esc(model.package.name)+'</button>' : '');
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
  const documentStyles = (document.CommunicationDocumentVersionStyles || []).map(item => {
    const style = item.CommunicationStyleConfigRec?.CommunicationStyleConfigInfo || {};
    const attributes = style.CommunicationStyleConfigStyleAttribute?.Items || [];
    return {
      name: style.ShortName || style.Name || 'Unnamed style',
      description: style.Desc || '',
      attributes: attributes.map(attribute => String(attribute.StyleAttributeName || '') + ': ' + String(attribute.StyleAttributeValue || '')),
    };
  });
  const model = { generatedAt: new Date().toISOString(), cacheDir, document: { name: info.ShortName || documentName, description: info.Desc || '', version: path.basename(documentFile, '.json'), styles: documentStyles }, package: packageContext(cacheDir, opts.package, info.ShortName || documentName), layouts: rootLayouts, content };
  const output = path.resolve(opts.output || path.join(cacheDir, `${documentName}-inspector.html`));
  ensureDir(path.dirname(output));
  fs.writeFileSync(output, renderMockupHtml(model));
  console.log(chalk.green(`Generated ${output}`));
  console.log(chalk.gray(`Latest cached document version: ${model.document.version}`));
}
