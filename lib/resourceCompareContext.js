/** Reader-facing explanations over the exact comparison evidence. */
import { JSDOM } from 'jsdom';
import { TextDecoder } from 'node:util';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const entries = value => Array.isArray(value) ? value : Array.isArray(value?.Items) ? value.Items : [];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const excerpt = value => { const text = String(value).replace(/\s+/g, ' ').trim(); return text.length > 90 ? text.slice(0, 87) + '…' : text; };
const uuid = value => typeof value === 'string' && /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value);
export const referenceType = key => {
  if (key === 'CompanyUuid') return 'company';
  const match = /^(?:Rel)?(?:Communication)?(Content|Document|Package|Layout|Style|Font|Chart(?:SeriesAxis|CategoryAxis|Series|Category|Annotation)?)(?:Version)?ConfigUuid$/.exec(key);
  return match ? match[1].replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null;
};
export const friendly = key => ({
  Id: 'Field', href: 'Link destination', URL: 'Link destination', OrgCompanyRole: 'Company role',
  CommunicationStyleConfigStyleAttribute: 'Style attributes', CommunicationStyleConfigElementType: 'Applies to elements',
  CommunicationContentVersionStyleRule: 'Style rule', '$$Id': 'Name', Desc: 'Description', Descr: 'Description', ShortName: 'Short name',
  ContentRelIndex: 'Position', LayoutRelIndex: 'Position', DocumentRelIndex: 'Position', StyleRelIndex: 'Position',
  ContentAlwaysTriggerInd: 'Inclusion rule', LayoutAlwaysTriggerInd: 'Inclusion rule', DocumentAlwaysTriggerInd: 'Inclusion rule',
  StyleAreaName: 'Style area', LayoutPlacement: 'Placement', StyleClassName: 'Style class',
  Condition: 'Inclusion condition', Path: 'Data path', Mandatory: 'Required', Type: 'Type',
  StyleAttributeName: 'Style attribute', StyleAttributeValue: 'Style value',
}[key] || String(key).replace(/^Communication/, '').replace(/Config(Info|Rec)$/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2'));
const collectionType = key => {
  if (/StyleAttribute/.test(key)) return 'style attribute';
  if (/Styles?$/.test(key)) return 'style';
  if (/Contents?$/.test(key)) return 'content';
  if (/Layouts?$/.test(key)) return 'layout';
  if (/Documents?$/.test(key)) return 'document';
  if (/Fields?$/.test(key)) return 'field';
  if (/Iteratio[nr]s?$/.test(key)) return 'iteration';
  if (/Companies|Company/.test(key)) return 'company';
  return null;
};
const groupName = type => ({ style: 'Styles', content: 'Content', layout: 'Layouts', document: 'Documents', field: 'Fields', iteration: 'Iterations', company: 'Companies' }[type] || friendly(type));
const namedInfo = (node, type) => {
  if (!object(node)) return null;
  if (node.ShortName || node['$$Id'] || node.Name || node.StyleAttributeName) return node;
  const prefix = String(type || '').replaceAll(' ', '').toLowerCase();
  const keys = Object.keys(node).filter(k => /(?:ConfigRec|ConfigInfo)$/.test(k) && !/Rel(?:Rec|Info)$/.test(k));
  keys.sort((a, b) => Number(b.toLowerCase().includes(prefix)) - Number(a.toLowerCase().includes(prefix)));
  for (const key of keys) {
    const found = namedInfo(node[key], type);
    if (found) return found;
  }
  return null;
};
const infoName = info => String(info?.ShortName || info?.['$$Id'] || info?.Name || info?.StyleAttributeName || '');

export function collectReferenceNames(record, names = {}, refs = {}) {
  if (Array.isArray(record)) { record.forEach(value => collectReferenceNames(value, names, refs)); return { names, refs }; }
  if (!object(record)) return { names, refs };
  // Learn names from expanded resources as well as the ShortName carried by a
  // relationship row. This avoids network calls for already expanded data.
  for (const [key, value] of Object.entries(record)) {
    const type = referenceType(key);
    if (!type || typeof value !== 'string' || !value) continue;
    refs[value] = type;
    const info = namedInfo(record, type);
    if (infoName(info)) names[value] = { type, name: infoName(info), description: info.Desc || info.Descr || '' };
  }
  for (const value of Object.values(record)) collectReferenceNames(value, names, refs);
  // RelInfo contains target and owner IDs; only attach a row-level ShortName to
  // the child side identified by the relationship collection's own metadata.
  for (const [key, value] of Object.entries(record)) {
    if (!/RelRec$/.test(key) || !object(value)) continue;
    const relInfo = Object.entries(value).find(([k]) => /RelInfo$/.test(k))?.[1];
    if (!object(relInfo)) continue;
    const candidates = Object.entries(relInfo).filter(([k]) => referenceType(k));
    for (const [refKey, id] of candidates) {
      const type = referenceType(refKey);
      const target = 'StyleRelIndex' in relInfo ? 'style' :
        'ContentRelIndex' in relInfo ? 'content' : 'LayoutRelIndex' in relInfo ? 'layout' : 'DocumentRelIndex' in relInfo ? 'document' : 'CompanyUuid' in relInfo ? 'company' : null;
      const hasExplicitChild = candidates.some(([key]) => key.startsWith('Rel') && referenceType(key) === type);
      if (type === target && record.ShortName && (!hasExplicitChild || refKey.startsWith('Rel'))) names[id] = { type, name: record.ShortName, description: '' };
    }
  }
  return { names, refs };
}

function relationFacts(node) {
  const facts = {};
  if (!object(node)) return facts;
  for (const [key, value] of Object.entries(node)) {
    if (/RelInfo$/.test(key) && object(value)) {
      for (const [property, setting] of Object.entries(value)) {
        if (/RelIndex$|AlwaysTriggerInd$/.test(property) || ['StyleAreaName', 'LayoutPlacement', 'StyleClassName'].includes(property)) {
          facts[friendly(property)] = /AlwaysTriggerInd$/.test(property) ? (setting === true ? 'Always included when its parent is included' : 'Conditional inclusion') : setting;
        }
      }
    } else if (/RelRec$/.test(key)) Object.assign(facts, relationFacts(value));
  }
  return facts;
}
function nodeName(node, type, names) {
  const info = namedInfo(node, type);
  if (infoName(info)) return infoName(info);
  const { refs } = collectReferenceNames(node);
  for (const [id, target] of Object.entries(refs)) if (target === type && names[id]?.name) return names[id].name;
  return null;
}
const titleCase = value => String(value).replace(/^./, c => c.toUpperCase());
const label = (type, name) => `${titleCase(friendly(type))}${name ? ` “${name}”` : ' (name unavailable)'}`;

function tokens(path) {
  const result = [];
  let at = path.startsWith('$') ? 1 : 0;
  while (at < path.length) {
    if (path[at] === '.') { at++; continue; }
    if (path[at] === '[') {
      const start = ++at;
      if (path[at] === '"') {
        at++;
        while (at < path.length) { if (path[at] === '\\') at += 2; else if (path[at++] === '"') break; }
        result.push(JSON.parse(path.slice(start, at)));
      } else {
        while (at < path.length && path[at] !== ']') at++;
        result.push(Number(path.slice(start, at)));
      }
      if (path[at] === ']') at++;
    } else {
      const start = at;
      while (at < path.length && !'.['.includes(path[at])) at++;
      result.push(path.slice(start, at));
    }
  }
  return result;
}
function trace(record, path, identity, root, names) {
  let node = record, collection = null;
  const frames = [{ type: root.type, name: root.name, node: record }];
  const parts = tokens(path);
  for (const part of parts) {
    if (Array.isArray(node)) {
      node = typeof part === 'number' ? node[part] : node.find(item => identity(item) === part);
      if (object(node) && collection) frames.push({ type: collection, name: nodeName(node, collection, names), node });
      collection = null;
    } else if (object(node)) {
      collection = collectionType(part);
      node = node[part];
      if (['Iteration', 'iteration'].includes(part) && object(node)) frames.push({ type: 'iteration', name: nodeName(node, 'iteration', names), node });
      if (/ConfigRec$/.test(String(part)) && !/RelRec$/.test(String(part)) && object(node)) {
        const type = referenceType(String(part).replace(/Rec$/, 'Uuid'));
        const name = nodeName(node, type, names);
        const previous = frames.at(-1);
        if (type && name && !(previous.type === type && previous.name === name)) frames.push({ type, name, node });
      }
    } else node = undefined;
  }
  return { frames, parts, node };
}
function readable(value, names, property = '') {
  if (value === undefined) return 'Not present';
  if (value === null) return 'Not set';
  if (value === '') return 'Empty text';
  if (referenceType(property)) return names[value]?.name || 'Referenced resource name unavailable';
  if (/AlwaysTriggerInd$/.test(property)) return value === true ? 'Always included when its parent is included' : 'Conditional inclusion';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (!object(value) && !Array.isArray(value)) return uuid(value) ? (names[value]?.name || 'Unresolved reference') : String(value);
  if (Array.isArray(value)) return value.map(item => readable(item, names, property)).join('\n') || 'None';
  if (value.StyleAttributeName) return `${value.StyleAttributeName}: ${readable(value.StyleAttributeValue, names)}`;
  const info = namedInfo(value);
  const facts = relationFacts(value);
  const lines = [];
  if (infoName(info)) lines.push(infoName(info));
  for (const key of ['Path', 'Condition', 'Type', 'Mandatory', 'Desc', 'Descr']) {
    if (value[key] !== undefined && value[key] !== '') lines.push(`${friendly(key)}: ${readable(value[key], names, key)}`);
  }
  for (const [key, setting] of Object.entries(facts)) lines.push(`${key}: ${setting === '' ? 'None' : Array.isArray(setting) ? setting.join(', ') : setting}`);
  for (const [key, children] of Object.entries(value)) {
    const type = collectionType(key);
    if (type && ['content', 'layout', 'document', 'style', 'field'].includes(type) && (Array.isArray(children) || Array.isArray(children?.Items))) {
      const rows = entries(children);
      if (rows.length) lines.push(`${groupName(type)}: ${rows.map(row => nodeName(row, type, names) || 'Name unavailable').join(', ')}`);
    }
  }
  if (lines.length) return lines.join('\n');
  const leaves = [];
  function visit(node, parents = []) {
    for (const [key, setting] of Object.entries(node)) {
      if (/Uuid$|^ConfigId|^Status$|^Links?$|^Layers$|^HasMore$|^TotalResults$/.test(key)) continue;
      if (object(setting)) visit(setting, parents);
      else if (Array.isArray(setting) && setting.some(object)) leaves.push(`${friendly(key)}: ${setting.length} entries`);
      else leaves.push(`${[...parents, friendly(key)].join(' / ')}: ${readable(setting, names, key)}`);
    }
  }
  visit(value);
  return leaves.slice(0, 12).join('\n') + (leaves.length > 12 ? `\n${leaves.length - 12} additional properties in technical details.` : '') || 'No additional settings';
}

export function explainRecordChanges(changes, before, after, root, identity, names) {
  const result = [];
  for (const change of changes) {
    if (change.path.startsWith('Artifacts')) continue;
    if (change.path.endsWith('.$order')) {
      const prefix = change.path.slice(0, -7);
      if (changes.some(other => other !== change && other.path.startsWith(prefix) && /RelIndex$/.test(other.path))) continue;
    }
    const a = trace(before, change.path, identity, root, names), b = trace(after, change.path, identity, root, names);
    const frames = b.frames.length >= a.frames.length ? b.frames : a.frames;
    const subject = frames.at(-1), container = frames.at(-2) || frames[0];
    const property = String(b.parts.at(-1));
    const category = property === 'Condition' || property === 'Path' || /AlwaysTriggerInd$/.test(property) ? 'Rules and data' :
      /RelIndex$/.test(property) || property === '$order' || ['LayoutPlacement', 'StyleAreaName'].includes(property) ? 'Order and placement' :
      subject.type === 'style' || subject.type === 'style attribute' || /Style/.test(property) ? 'Styles and formatting' : 'Resource settings';
    const where = frames.filter((frame, i) => i === 0 || frame.type !== frames[i - 1].type || frame.name !== frames[i - 1].name).map(frame => {
      const facts = relationFacts(frame.node);
      const placement = ['Position', 'Style area', 'Style class', 'Placement'].filter(key => facts[key] !== undefined && facts[key] !== '').map(key => `${key.toLowerCase()} ${facts[key]}`);
      return label(frame.type, frame.name) + (placement.length ? ` (${placement.join('; ')})` : '');
    }).join(' → ');
    let title, left = readable(change.before, names, property), right = readable(change.after, names, property), note = '';
    if (referenceType(property)) {
      const type = referenceType(property);
      const oldName = names[change.before]?.name, newName = names[change.after]?.name;
      title = `${titleCase(friendly(type))} reference changed in ${label(subject.type, subject.name)}`;
      if (oldName && oldName === newName) note = 'The relationship points to a different record with the same short name; this alone does not establish a change to its appearance or behavior.';
      else if (!oldName || !newName) note = 'A referenced record changed, but one or both names could not be resolved. Exact identifiers remain in the technical evidence.';
    } else if (property === '$order') {
      const type = collectionType(a.parts.at(-2)) || 'item';
      title = `${titleCase(friendly(type))} order changed in ${label(subject.type, subject.name)}`;
      const order = values => values.map((id, i) => `${i + 1}. ${names[id]?.name || (uuid(id) ? 'Name unavailable' : id)}`).join('\n');
      left = order(change.before); right = order(change.after);
    } else if (/RelIndex$/.test(property)) title = `${label(subject.type, subject.name)} moved within ${label(container.type, container.name)}`;
    else if (/AlwaysTriggerInd$/.test(property)) {
      title = `Inclusion rule changed for ${label(subject.type, subject.name)}`;
      note = 'This is the relationship’s inclusion flag. Conditional inclusion still depends on the applicable Assembly Template condition.';
    } else if (property === 'StyleAttributeValue') {
      const name = b.frames.findLast(frame => frame.type === 'style attribute')?.name || a.frames.findLast(frame => frame.type === 'style attribute')?.name;
      const style = [...frames].reverse().find(frame => frame.type === 'style') || root;
      title = `${friendly(name || 'Style value')} changed for ${label(style.type, style.name)}`;
    } else if ((change.kind === 'added' || change.kind === 'removed') && (object(change.after) || object(change.before))) {
      title = `${label(subject.type, subject.name)} ${change.kind === 'added' ? 'added to' : 'removed from'} ${label(container.type, container.name)}`;
    } else if ((change.kind === 'added' || change.kind === 'removed') && Array.isArray(change.after || change.before)) {
      title = `${groupName(collectionType(property) || friendly(property))} ${change.kind} in ${label(subject.type, subject.name)}`;
    } else if (/VersionConfigInfo$/.test(String(b.parts.at(-2))) && ['ShortName', 'Desc'].includes(property)) {
      title = `Version ${property === 'ShortName' ? 'label' : 'description'} changed for ${label(subject.type, subject.name)}`;
    } else title = `${friendly(property)} ${change.kind} for ${label(subject.type, subject.name)}`;
    if (change.kind === 'changed' && !object(change.before) && !object(change.after)
        && !Array.isArray(change.before) && !Array.isArray(change.after) && left !== right) {
      const shortRule = value => /AlwaysTriggerInd$/.test(property) ? (value === true ? 'Always included' : 'Conditional') : readable(value, names, property);
      title += `: ${excerpt(shortRule(change.before))} → ${excerpt(shortRule(change.after))}`;
    }
    result.push({ category, kind: change.kind, title, where, before: left, after: right, ...(note ? { note } : {}), evidencePaths: [change.path] });
  }
  return result;
}

function htmlView(bytes) {
  let dom = new JSDOM(Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n'));
  if (!dom.window.document.querySelector('comms-data,comms-cond,comms-loop') && /<\/?(?:comms-|p[\s>]|div[\s>])/.test(dom.window.document.body.textContent)) {
    const decoded = dom.window.document.body.textContent;
    dom.window.close(); dom = new JSDOM(decoded);
  }
  const document = dom.window.document;
  const payload = element => {
    const text = element.textContent.trim().replace(/^\$(?:Data|Cond|Loop)\s*/, '');
    try { return JSON.parse(text); } catch {
      // Nested $Data JSON inside a quoted $Cond string is emitted without
      // escaped quotes by some Comms editors. Protect it while parsing the
      // surrounding instruction, then restore the authored expression.
      const fragments = [];
      const masked = text.replace(/\$Data\s*\{[^}]*\}/g, value => { fragments.push(value); return `__DATA_${fragments.length - 1}__`; });
      try {
        const parsed = JSON.parse(masked);
        return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/__DATA_(\d+)__/g, (_, i) => fragments[Number(i)]) : value]));
      } catch { return { Unparsed: text }; }
    }
  };
  const location = element => {
    const block = element.closest('p,li,td,th,h1,h2,h3,div') || document.body;
    const matches = [...document.querySelectorAll(block.tagName)];
    return `${({ P: 'Paragraph', TD: 'Table cell', TH: 'Table heading', LI: 'List item' }[block.tagName] || friendly(block.tagName.toLowerCase()))} ${matches.indexOf(block) + 1}`;
  };
  const fields = [...document.querySelectorAll('comms-data')].filter(e => { const loop = e.closest('comms-loop'); return !loop || loop.querySelector('comms-data') !== e; }).map(element => ({ value: payload(element), where: location(element) }));
  const conditions = [...document.querySelectorAll('comms-cond')].map(element => ({ value: payload(element), where: location(element) }));
  const loops = [...document.querySelectorAll('comms-loop')].map(element => ({ value: element.querySelector('comms-data') ? payload(element.querySelector('comms-data')) : payload(element), where: location(element) }));
  const transforms = [...document.querySelectorAll('comms-transform')].map(element => ({ value: Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])), where: location(element) }));
  const formatting = [...document.querySelectorAll('body *')].filter(e => !e.tagName.toLowerCase().startsWith('comms-')).map(element => ({
    element: `${({ P: 'Paragraph', TD: 'Table cell', TH: 'Table heading', DIV: 'Block', TABLE: 'Table', TR: 'Table row', SPAN: 'Text span', LI: 'List item' }[element.tagName] || element.tagName.toLowerCase())} ${[...document.querySelectorAll(element.tagName)].indexOf(element) + 1}`,
    attributes: Object.fromEntries([...element.attributes].map(attr => [attr.name, attr.value])) }));
  const css = [...document.querySelectorAll('style')].map(element => element.textContent);
  const scripts = [...document.querySelectorAll('script')].map(element => element.textContent);
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style').forEach(element => element.remove());
  clone.querySelectorAll('comms-data,comms-cond,comms-loop').forEach(element => element.replaceWith(document.createTextNode(`[${({ 'COMMS-DATA': 'field', 'COMMS-COND': 'conditional content', 'COMMS-LOOP': 'repeated section' }[element.tagName] || 'dynamic content')}]`)));
  clone.querySelectorAll('p,div,li,tr,br,h1,h2,h3').forEach(element => element.append(document.createTextNode('\n')));
  const text = clone.textContent.trim();
  dom.window.close();
  return { text, fields, conditions, loops, transforms, formatting, css, scripts };
}

export function explainArtifacts(before, after, names) {
  const result = [], a = new Map((before.artifacts || []).map(item => [item.label, item])), b = new Map((after.artifacts || []).map(item => [item.label, item]));
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if ((before.missingArtifacts || []).includes(key) || (after.missingArtifacts || []).includes(key)
        || (!a.has(key) && before.issues?.length) || (!b.has(key) && after.issues?.length)) continue;
    const left = a.get(key), right = b.get(key), where = `${label(before.type, before.name)} → ${key}`;
    if (left && right && Buffer.from(left.bytes).equals(Buffer.from(right.bytes))) continue;
    const textOf = artifact => {
      if (!artifact?.text) return null;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(artifact.bytes)).replace(/\r\n/g, '\n'); }
      catch { return null; }
    };
    const leftText = textOf(left), rightText = textOf(right);
    if (left && right && leftText !== null && rightText !== null && leftText === rightText) continue;
    const add = (category, title, l, r, note = '') => result.push({ category, kind: !left ? 'added' : !right ? 'removed' : 'changed', title, where, before: l, after: r,
      ...(note ? { note } : {}), evidencePaths: [`Artifacts[${JSON.stringify(key)}]`] });
    if (left?.html && right?.html && leftText !== null && rightText !== null) {
      const l = htmlView(left.bytes), r = htmlView(right.bytes), start = result.length;
      if (l.text !== r.text) add('Text', `Authored text changed: “${excerpt(l.text)}” → “${excerpt(r.text)}”`, l.text, r.text, 'Square-bracket markers indicate dynamic fields, conditions or repeated sections; mapped output is not evaluated here.');
      for (const [part, category, title] of [['fields', 'Fields', 'Field binding'], ['conditions', 'Rules and data', 'Conditional content'], ['loops', 'Rules and data', 'Repeated section'], ['transforms', 'Fields', 'Field transform']]) {
        for (let i = 0; i < Math.max(l[part].length, r[part].length); i++) {
          const old = l[part][i], fresh = r[part][i];
          if (equal(old?.value, fresh?.value)) continue;
          const namedChange = old?.value?.Id && fresh?.value?.Id && old.value.Id !== fresh.value.Id ? `: ${excerpt(old.value.Id)} → ${excerpt(fresh.value.Id)}` : '';
          add(category, `${title} ${!old ? 'added' : !fresh ? 'removed' : 'changed'} in ${fresh?.where || old?.where}${namedChange}`,
            readable(old?.value, names), readable(fresh?.value, names));
        }
      }
      const lf = new Map(l.formatting.map(item => [item.element, item.attributes]));
      const rf = new Map(r.formatting.map(item => [item.element, item.attributes]));
      for (const element of new Set([...lf.keys(), ...rf.keys()])) {
        const old = lf.get(element), fresh = rf.get(element);
        if (equal(old, fresh)) continue;
        if (!old || !fresh) add('Styles and formatting', `HTML element ${!old ? 'added' : 'removed'}: ${element}`, readable(old, names), readable(fresh, names));
        else for (const attribute of new Set([...Object.keys(old), ...Object.keys(fresh)])) {
          if (old[attribute] !== fresh[attribute]) add('Styles and formatting', `${element}: ${attribute === 'class' ? 'style class' : attribute} changed: ${excerpt(old[attribute] ?? 'None')} → ${excerpt(fresh[attribute] ?? 'None')}`,  readable(old[attribute], names), readable(fresh[attribute], names));
        }
      }
      for (const [part, title] of [['css', 'Embedded CSS'], ['scripts', 'Embedded script']]) {
        for (let i = 0; i < Math.max(l[part].length, r[part].length); i++) if (l[part][i] !== r[part][i]) {
          add('Styles and formatting', `${title} block ${i + 1} changed`, readable(l[part][i], names), readable(r[part][i], names));
        }
      }
      if (result.length === start) add('Styles and formatting', 'Source markup changed', 'Previous markup', 'Updated markup', 'The saved markup differs while the extracted text and Comms instructions match. Exact markup is available in technical evidence.');
    } else {
      add(leftText !== null && rightText !== null ? 'Text' : 'Files', `${key} ${!left ? 'added' : !right ? 'removed' : 'changed'}`,
        !left ? 'Not present' : leftText !== null ? leftText : `${Buffer.byteLength(left.bytes)} bytes`,
        !right ? 'Not present' : rightText !== null ? rightText : `${Buffer.byteLength(right.bytes)} bytes`,
        left && right && !(leftText !== null && rightText !== null) ? 'The file bytes differ. This does not establish what changed visually; hashes are retained in the JSON evidence.' : '');
    }
  }
  return result;
}

export function explainMetadata(changes, before, after, root, identity, names) {
  return explainRecordChanges(changes.filter(change => !/ConfigId|Updated|Created|RelRec.*Status/.test(change.path)), before, after, root, identity, names).map((entry, index) => {
    const raw = changes.filter(change => !/ConfigId|Updated|Created|RelRec.*Status/.test(change.path))[index];
    if (raw.path.endsWith('.Status')) {
      const status = value => entries(value).map(item => `${item.StatusCode || item.Code || 'Unknown'}${item.EffDtTm ? ` (effective ${item.EffDtTm.slice(0, 10)})` : ''}`).join('\n') || 'Not recorded';
      entry.before = status(raw.before); entry.after = status(raw.after);
    }
    return entry;
  }).filter(entry => entry.before !== entry.after);
}
