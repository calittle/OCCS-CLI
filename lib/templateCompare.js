import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${label} JSON at ${filePath}: ${err.message}`);
  }
}

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeMetaValue(value) {
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (value === undefined) return '';
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toId(value, fallback) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function pickMetadata(source, excludedKeys = []) {
  const out = {};
  const skip = new Set(excludedKeys);
  for (const [key, rawValue] of Object.entries(source || {})) {
    if (skip.has(key)) continue;
    out[key] = normalizeMetaValue(rawValue);
  }
  return out;
}

function diffMetadata(metaA, metaB) {
  const changes = [];
  const keys = [...new Set([...Object.keys(metaA || {}), ...Object.keys(metaB || {})])]
    .sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

  for (const key of keys) {
    const a = Object.prototype.hasOwnProperty.call(metaA || {}, key) ? metaA[key] : undefined;
    const b = Object.prototype.hasOwnProperty.call(metaB || {}, key) ? metaB[key] : undefined;
    if (a !== b) {
      changes.push({ key, a, b });
    }
  }

  return changes;
}

function makeFieldMap(fields) {
  const map = new Map();
  const items = Array.isArray(fields) ? fields : [];

  for (let i = 0; i < items.length; i += 1) {
    const field = items[i] || {};
    const name = toId(field.Name, `(unnamed field #${i + 1})`);
    map.set(name, {
      name,
      path: normalizeWhitespace(field.Path),
      mandatory: field.Mandatory === true,
      desc: normalizeWhitespace(field.Desc),
      metadata: pickMetadata(field, ['Name', 'Path', 'Mandatory', 'Desc']),
    });
  }
  return map;
}

function compareFieldMaps(aFields, bFields) {
  const onlyInA = [];
  const onlyInB = [];
  const changed = [];

  const allNames = new Set([...aFields.keys(), ...bFields.keys()]);
  const sortedNames = [...allNames].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

  for (const name of sortedNames) {
    const a = aFields.get(name);
    const b = bFields.get(name);

    if (!a && b) {
      onlyInB.push(name);
      continue;
    }
    if (a && !b) {
      onlyInA.push(name);
      continue;
    }

    const delta = [];
    if (a.path !== b.path) delta.push({ key: 'Path', a: a.path, b: b.path });
    if (a.mandatory !== b.mandatory) delta.push({ key: 'Mandatory', a: a.mandatory, b: b.mandatory });
    if (a.desc !== b.desc) delta.push({ key: 'Desc', a: a.desc, b: b.desc });
    const metadataChanges = diffMetadata(a.metadata, b.metadata).map((m) => ({
      key: `Metadata.${m.key}`,
      a: m.a,
      b: m.b,
    }));
    delta.push(...metadataChanges);
    if (delta.length) {
      changed.push({ name, changes: delta });
    }
  }

  return { onlyInA, onlyInB, changed };
}

function extractIteration(iteration) {
  if (!iteration || typeof iteration !== 'object') return null;
  return {
    id: toId(iteration['$$Id'], '(no-iteration-id)'),
    type: normalizeWhitespace(iteration.Type),
    path: normalizeWhitespace(iteration.Path),
    fields: makeFieldMap(iteration.Fields),
  };
}

function flattenLayouts(layouts, parentPath = '', out = []) {
  const list = Array.isArray(layouts) ? layouts : [];
  for (let i = 0; i < list.length; i += 1) {
    const layout = list[i] || {};
    const layoutId = toId(layout['$$Id'], `Layouts[${i}]`);
    const currentPath = parentPath ? `${parentPath} > ${layoutId}` : layoutId;
    const contents = Array.isArray(layout.Contents) ? layout.Contents : [];

    const contentMap = new Map();
    for (let c = 0; c < contents.length; c += 1) {
      const content = contents[c] || {};
      const contentId = toId(content['$$Id'], `Contents[${c}]`);
      contentMap.set(contentId, {
        id: contentId,
        condition: normalizeWhitespace(content.Condition),
        iteration: extractIteration(content.Iteration),
      });
    }

    out.push({
      id: layoutId,
      path: currentPath,
      condition: normalizeWhitespace(layout.Condition),
      contentMap,
    });

    flattenLayouts(layout.Layouts, currentPath, out);
  }
  return out;
}

function buildDocumentMap(template) {
  const docs = Array.isArray(template?.Documents) ? template.Documents : [];
  const map = new Map();

  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i] || {};
    const docId = toId(doc['$$Id'], `Documents[${i}]`);
    const layouts = flattenLayouts(doc.Layouts);
    const layoutMap = new Map(layouts.map((l) => [l.path, l]));
    map.set(docId, {
      id: docId,
      condition: normalizeWhitespace(doc.Condition),
      metadata: pickMetadata(doc, ['$$Id', 'Condition', 'Layouts']),
      layoutMap,
    });
  }

  return map;
}

function compareIteration(aIter, bIter) {
  if (!aIter && !bIter) return null;
  if (aIter && !bIter) return { type: 'removed' };
  if (!aIter && bIter) return { type: 'added' };

  const metaChanges = [];
  if (aIter.id !== bIter.id) metaChanges.push({ key: 'Iteration.$$Id', a: aIter.id, b: bIter.id });
  if (aIter.type !== bIter.type) metaChanges.push({ key: 'Iteration.Type', a: aIter.type, b: bIter.type });
  if (aIter.path !== bIter.path) metaChanges.push({ key: 'Iteration.Path', a: aIter.path, b: bIter.path });
  const fieldDiff = compareFieldMaps(aIter.fields, bIter.fields);
  if (!metaChanges.length && !fieldDiff.onlyInA.length && !fieldDiff.onlyInB.length && !fieldDiff.changed.length) {
    return null;
  }

  return { type: 'changed', metaChanges, fieldDiff };
}

function compareDocuments(aDocs, bDocs) {
  const onlyInA = [];
  const onlyInB = [];
  const changed = [];
  const allDocIds = new Set([...aDocs.keys(), ...bDocs.keys()]);
  const sortedDocIds = [...allDocIds].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

  for (const docId of sortedDocIds) {
    const aDoc = aDocs.get(docId);
    const bDoc = bDocs.get(docId);

    if (aDoc && !bDoc) {
      onlyInA.push(docId);
      continue;
    }
    if (!aDoc && bDoc) {
      onlyInB.push(docId);
      continue;
    }

    const docChanges = [];
    if (aDoc.condition !== bDoc.condition) {
      docChanges.push({
        type: 'doc-condition',
        key: 'Condition',
        a: aDoc.condition,
        b: bDoc.condition,
      });
    }
    const docMetaChanges = diffMetadata(aDoc.metadata, bDoc.metadata);
    for (const meta of docMetaChanges) {
      docChanges.push({
        type: 'doc-metadata',
        key: meta.key,
        a: meta.a,
        b: meta.b,
      });
    }

    const aLayoutPaths = new Set(aDoc.layoutMap.keys());
    const bLayoutPaths = new Set(bDoc.layoutMap.keys());
    const allPaths = new Set([...aLayoutPaths, ...bLayoutPaths]);
    const sortedPaths = [...allPaths].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

    for (const layoutPath of sortedPaths) {
      const aLayout = aDoc.layoutMap.get(layoutPath);
      const bLayout = bDoc.layoutMap.get(layoutPath);

      if (aLayout && !bLayout) {
        docChanges.push({ type: 'layout-removed', layoutPath, layoutId: aLayout.id });
        continue;
      }
      if (!aLayout && bLayout) {
        docChanges.push({ type: 'layout-added', layoutPath, layoutId: bLayout.id });
        continue;
      }

      if (aLayout.condition !== bLayout.condition) {
        docChanges.push({
          type: 'layout-condition',
          layoutPath,
          key: 'Condition',
          a: aLayout.condition,
          b: bLayout.condition,
        });
      }

      const aContentIds = new Set(aLayout.contentMap.keys());
      const bContentIds = new Set(bLayout.contentMap.keys());
      const contentIds = [...new Set([...aContentIds, ...bContentIds])]
        .sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }));

      for (const contentId of contentIds) {
        const aContent = aLayout.contentMap.get(contentId);
        const bContent = bLayout.contentMap.get(contentId);

        if (aContent && !bContent) {
          docChanges.push({ type: 'content-removed', layoutPath, contentId });
          continue;
        }
        if (!aContent && bContent) {
          docChanges.push({ type: 'content-added', layoutPath, contentId });
          continue;
        }

        if (aContent.condition !== bContent.condition) {
          docChanges.push({
            type: 'content-condition',
            layoutPath,
            contentId,
            key: 'Condition',
            a: aContent.condition,
            b: bContent.condition,
          });
        }

        const iterationChange = compareIteration(aContent.iteration, bContent.iteration);
        if (iterationChange) {
          docChanges.push({
            type: 'content-iteration',
            layoutPath,
            contentId,
            change: iterationChange,
          });
        }
      }
    }

    if (docChanges.length) changed.push({ docId, changes: docChanges });
  }

  return { onlyInA, onlyInB, changed };
}

function summarize(diff) {
  const documentChanges =
    diff.documents.onlyInA.length +
    diff.documents.onlyInB.length +
    diff.documents.changed.reduce((count, item) => count + item.changes.length, 0);
  const fieldChanges =
    diff.fields.onlyInA.length +
    diff.fields.onlyInB.length +
    diff.fields.changed.length;

  return {
    sameTemplateId: diff.templateA.id === diff.templateB.id,
    documentChanges,
    fieldChanges,
    hasDifferences: documentChanges > 0 || fieldChanges > 0 || diff.templateA.id !== diff.templateB.id,
  };
}

function displayValue(value) {
  return value === undefined ? '(missing)' : String(value);
}

function formatDiffPretty(diff) {
  const lines = [];
  const summary = summarize(diff);
  const ok = chalk.blue('✓');
  const warn = chalk.magenta('!');
  const err = chalk.yellow('x');
  const title = chalk.cyanBright.bold;
  const heading = chalk.cyanBright.bold;
  const docHeading = (docId) => chalk.bgHex('#303030').hex('#ffd166').bold(` DOC: ${docId} `);
  const aLabel = chalk.yellow.bold('A:');
  const bLabel = chalk.cyan.bold('B:');
  const aValue = (value) => chalk.yellow(displayValue(value));
  const bValue = (value) => chalk.cyan(displayValue(value));
  const aInline = (value) => chalk.yellow(String(value || '(empty)'));
  const bInline = (value) => chalk.cyan(String(value || '(empty)'));
  const diffLabel = (text) => chalk.whiteBright.bold.underline(text);

  lines.push(title('Assembly Template Comparison'));
  lines.push(`${aLabel} ${chalk.yellow(`${diff.templateA.path} (${diff.templateA.id || '(no $$Id)'})`)}`);
  lines.push(`${bLabel} ${chalk.cyan(`${diff.templateB.path} (${diff.templateB.id || '(no $$Id)'})`)}`);
  lines.push('');
  lines.push(`Template $$Id: ${summary.sameTemplateId ? ok : warn} ${diff.templateA.id || '(empty)'} vs ${diff.templateB.id || '(empty)'}`);
  lines.push(chalk.whiteBright(`Document diffs: ${summary.documentChanges}`));
  lines.push(chalk.whiteBright(`Field diffs: ${summary.fieldChanges}`));

  lines.push('');
  lines.push(heading('Documents'));
  if (!diff.documents.onlyInA.length && !diff.documents.onlyInB.length && !diff.documents.changed.length) {
    lines.push(`${ok} No document-level differences found.`);
  } else {
    if (diff.documents.onlyInA.length) {
      lines.push(chalk.yellowBright(`Only in A (${diff.documents.onlyInA.length}): ${diff.documents.onlyInA.join(', ')}`));
    }
    if (diff.documents.onlyInB.length) {
      lines.push(chalk.cyanBright(`Only in B (${diff.documents.onlyInB.length}): ${diff.documents.onlyInB.join(', ')}`));
    }

    for (const doc of diff.documents.changed) {
      lines.push('');
      lines.push(docHeading(doc.docId));
      for (const change of doc.changes) {
        if (change.type === 'doc-condition') {
          lines.push(`  ${warn} ${diffLabel('Document condition changed')}`);
          lines.push(`    ${aLabel} ${aInline(change.a)}`);
          lines.push(`    ${bLabel} ${bInline(change.b)}`);
        } else if (change.type === 'doc-metadata') {
          lines.push(`  ${warn} ${diffLabel(`Document metadata changed: ${change.key}`)}`);
          lines.push(`    ${aLabel} ${aValue(change.a)}`);
          lines.push(`    ${bLabel} ${bValue(change.b)}`);
        } else if (change.type === 'layout-added') {
          lines.push(`  ${warn} ${chalk.cyanBright.bold.underline(`Layout added in B: ${change.layoutPath}`)}`);
        } else if (change.type === 'layout-removed') {
          lines.push(`  ${warn} ${chalk.yellowBright.bold.underline(`Layout removed from B: ${change.layoutPath}`)}`);
        } else if (change.type === 'layout-condition') {
          lines.push(`  ${warn} ${diffLabel(`Layout condition changed: ${change.layoutPath}`)}`);
          lines.push(`    ${aLabel} ${aInline(change.a)}`);
          lines.push(`    ${bLabel} ${bInline(change.b)}`);
        } else if (change.type === 'content-added') {
          lines.push(`  ${warn} ${chalk.cyanBright.bold.underline(`Content added in B: ${change.layoutPath} / ${change.contentId}`)}`);
        } else if (change.type === 'content-removed') {
          lines.push(`  ${warn} ${chalk.yellowBright.bold.underline(`Content removed from B: ${change.layoutPath} / ${change.contentId}`)}`);
        } else if (change.type === 'content-condition') {
          lines.push(`  ${warn} ${diffLabel(`Content condition changed: ${change.layoutPath} / ${change.contentId}`)}`);
          lines.push(`    ${aLabel} ${aInline(change.a)}`);
          lines.push(`    ${bLabel} ${bInline(change.b)}`);
        } else if (change.type === 'content-iteration') {
          const iter = change.change;
          if (iter.type === 'added') {
            lines.push(`  ${warn} ${chalk.cyanBright.bold.underline(`Iteration added in B: ${change.layoutPath} / ${change.contentId}`)}`);
          } else if (iter.type === 'removed') {
            lines.push(`  ${warn} ${chalk.yellowBright.bold.underline(`Iteration removed from B: ${change.layoutPath} / ${change.contentId}`)}`);
          } else {
            lines.push(`  ${warn} ${diffLabel(`Iteration changed: ${change.layoutPath} / ${change.contentId}`)}`);
            for (const meta of iter.metaChanges) {
              lines.push(`    ${meta.key}`);
              lines.push(`      ${aLabel} ${aInline(meta.a)}`);
              lines.push(`      ${bLabel} ${bInline(meta.b)}`);
            }
            if (iter.fieldDiff.onlyInA.length) {
              lines.push(`    ${chalk.yellowBright(`Iteration fields only in A: ${iter.fieldDiff.onlyInA.join(', ')}`)}`);
            }
            if (iter.fieldDiff.onlyInB.length) {
              lines.push(`    ${chalk.cyanBright(`Iteration fields only in B: ${iter.fieldDiff.onlyInB.join(', ')}`)}`);
            }
            for (const changedField of iter.fieldDiff.changed) {
              lines.push(`    ${chalk.whiteBright(`Iteration field changed: ${changedField.name}`)}`);
              for (const c of changedField.changes) {
                lines.push(`      ${c.key}`);
                lines.push(`        ${aLabel} ${aValue(c.a)}`);
                lines.push(`        ${bLabel} ${bValue(c.b)}`);
              }
            }
          }
        }
      }
    }
  }

  lines.push('');
  lines.push(heading('Fields'));
  if (!diff.fields.onlyInA.length && !diff.fields.onlyInB.length && !diff.fields.changed.length) {
    lines.push(`${ok} No field differences found.`);
  } else {
    if (diff.fields.onlyInA.length) {
      lines.push(chalk.yellowBright(`Only in A (${diff.fields.onlyInA.length}): ${diff.fields.onlyInA.join(', ')}`));
    }
    if (diff.fields.onlyInB.length) {
      lines.push(chalk.cyanBright(`Only in B (${diff.fields.onlyInB.length}): ${diff.fields.onlyInB.join(', ')}`));
    }
    for (const field of diff.fields.changed) {
      lines.push(`${err} ${chalk.whiteBright.bold(`Field mapping changed: ${field.name}`)}`);
      for (const c of field.changes) {
        lines.push(`  ${chalk.whiteBright(c.key)}`);
        lines.push(`    ${aLabel} ${aValue(c.a)}`);
        lines.push(`    ${bLabel} ${bValue(c.b)}`);
      }
    }
  }

  if (!summary.hasDifferences) {
    lines.push('');
    lines.push(chalk.blue('No semantic differences found.'));
  }

  return lines.join('\n');
}

function formatDiffMarkdown(diff) {
  const summary = summarize(diff);
  const lines = [];
  lines.push('# Assembly Template Comparison');
  lines.push(`- **A**: \`${diff.templateA.path}\` (\`${diff.templateA.id || '(no $$Id)'}\`)`);
  lines.push(`- **B**: \`${diff.templateB.path}\` (\`${diff.templateB.id || '(no $$Id)'}\`)`);
  lines.push(`- **Template $$Id**: ${summary.sameTemplateId ? 'same' : 'different'}`);
  lines.push(`- **Document diffs**: ${summary.documentChanges}`);
  lines.push(`- **Field diffs**: ${summary.fieldChanges}`);
  lines.push('');
  lines.push('## Documents');
  if (!diff.documents.onlyInA.length && !diff.documents.onlyInB.length && !diff.documents.changed.length) {
    lines.push('- No document-level differences found.');
  } else {
    if (diff.documents.onlyInA.length) lines.push(`- Only in A: ${diff.documents.onlyInA.join(', ')}`);
    if (diff.documents.onlyInB.length) lines.push(`- Only in B: ${diff.documents.onlyInB.join(', ')}`);
    for (const doc of diff.documents.changed) {
      lines.push(`- **${doc.docId}**`);
      for (const change of doc.changes) {
        if (change.type === 'doc-condition') {
          lines.push(`- doc condition changed (A: \`${change.a || '(empty)'}\`, B: \`${change.b || '(empty)'}\`)`);
        } else if (change.type === 'doc-metadata') {
          lines.push(`- doc metadata changed: \`${change.key}\` (A: \`${displayValue(change.a)}\`, B: \`${displayValue(change.b)}\`)`);
        } else if (change.type === 'layout-added') {
          lines.push(`- layout added in B: \`${change.layoutPath}\``);
        } else if (change.type === 'layout-removed') {
          lines.push(`- layout removed from B: \`${change.layoutPath}\``);
        } else if (change.type === 'layout-condition') {
          lines.push(`- layout condition changed: \`${change.layoutPath}\``);
        } else if (change.type === 'content-added') {
          lines.push(`- content added in B: \`${change.layoutPath} / ${change.contentId}\``);
        } else if (change.type === 'content-removed') {
          lines.push(`- content removed from B: \`${change.layoutPath} / ${change.contentId}\``);
        } else if (change.type === 'content-condition') {
          lines.push(`- content condition changed: \`${change.layoutPath} / ${change.contentId}\``);
        } else if (change.type === 'content-iteration') {
          lines.push(`- iteration ${change.change.type}: \`${change.layoutPath} / ${change.contentId}\``);
        }
      }
    }
  }
  lines.push('');
  lines.push('## Fields');
  if (!diff.fields.onlyInA.length && !diff.fields.onlyInB.length && !diff.fields.changed.length) {
    lines.push('- No field differences found.');
  } else {
    if (diff.fields.onlyInA.length) lines.push(`- Only in A: ${diff.fields.onlyInA.join(', ')}`);
    if (diff.fields.onlyInB.length) lines.push(`- Only in B: ${diff.fields.onlyInB.join(', ')}`);
    for (const field of diff.fields.changed) {
      lines.push(`- Field changed: \`${field.name}\``);
      for (const c of field.changes) {
        lines.push(`- ${c.key} (A: \`${displayValue(c.a)}\`, B: \`${displayValue(c.b)}\`)`);
      }
    }
  }
  return lines.join('\n');
}

function makeDiff(aPath, bPath, aTemplate, bTemplate) {
  const aDocs = buildDocumentMap(aTemplate);
  const bDocs = buildDocumentMap(bTemplate);
  const aFields = makeFieldMap(aTemplate?.Fields);
  const bFields = makeFieldMap(bTemplate?.Fields);

  return {
    templateA: {
      path: aPath,
      id: aTemplate?.['$$Id'] || '',
    },
    templateB: {
      path: bPath,
      id: bTemplate?.['$$Id'] || '',
    },
    documents: compareDocuments(aDocs, bDocs),
    fields: compareFieldMaps(aFields, bFields),
  };
}

export async function templateCompareCommand(opts) {
  const format = String(opts.format || 'pretty').toLowerCase();
  if (!['pretty', 'md', 'json'].includes(format)) {
    throw new Error(`Invalid --format "${opts.format}". Expected one of: pretty, md, json`);
  }

  const inputA = path.resolve(opts.a);
  const inputB = path.resolve(opts.b);
  const templateA = readJsonFile(inputA, 'template A');
  const templateB = readJsonFile(inputB, 'template B');
  const diff = makeDiff(inputA, inputB, templateA, templateB);

  if (format === 'json') {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  if (format === 'md') {
    console.log(formatDiffMarkdown(diff));
    return;
  }

  console.log(formatDiffPretty(diff));
}
