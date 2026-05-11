import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { ensureDir, safePathSegment } from './utils.js';

const sanitize = (str) => `"${str.replaceAll('"', '').replaceAll('\\', '\\\\')}"`;

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
  const headers = lines.shift().replace(/^\uFEFF/, '').split(',').map(h => h.trim().replace(/^"|"$/g, ''));

  const [rootIdx, sourceTypeIdx, sourceIdIdx, relationIdx, targetTypeIdx, targetIdIdx] =
    ['RootDocument', 'SourceType', 'SourceId', 'Relation', 'TargetType', 'TargetId']
      .map(h => headers.findIndex(col => col.trim() === h));  

  const buildGraph = (doc, docLines) => {
    const edges = new Set();
    const nodes = new Set();

    for (const line of docLines) {
      const cols = line.split(',').map(h => h.trim().replace(/^"|"$/g, ''));

      // Skip if style exclusion is active
      if (!cmd.styles && (cols[sourceTypeIdx] === 'Style' || cols[targetTypeIdx] === 'Style')) continue;

      if (!cmd.fields && (cols[targetTypeIdx] === 'Field' || cols[sourceIdIdx] === 'Field')) continue;

      const source = sanitize(`${cols[sourceTypeIdx]}: ${cols[sourceIdIdx]}`);
      const target = sanitize(`${cols[targetTypeIdx]}: ${cols[targetIdIdx]}`);
      const label = sanitize(cols[relationIdx]);
      nodes.add(source);
      nodes.add(target);
      edges.add(`  ${source} -> ${target} [label=${label}];`);
    }

    const dot = [
      'digraph CCS {',
      '  node [shape=box, style=filled, fillcolor=lightgray, fontname="Helvetica"];',
      '  edge [fontname="Helvetica", fontsize=9];',
      ...[...nodes].map(n => `  ${n};`),
      ...edges,
      '}'
    ].join('\n');

    return dot;
  };

  if (cmd.document) {
    const filteredLines = lines.filter(line => {
      const cols = line.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      return cols[rootIdx] === cmd.document;
    });

    if (filteredLines.length === 0) {
      console.error(chalk.red(`❌ No data found for document "${cmd.document}".`));
      return;
    }

    const safeDocument = safePathSegment(cmd.document);
    const dotPath = path.join(reportDir, `${safeDocument}.dot`);
    const svgPath = path.join(reportDir, `${safeDocument}.svg`);

    const dot = buildGraph(cmd.document, filteredLines);
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
    for (const line of lines) {
      const cols = line.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      const rootDoc = cols[rootIdx];
      const sourceType = cols[sourceTypeIdx];
      const relation = cols[relationIdx];
      const targetType = cols[targetTypeIdx];

      // Only collect top-level Document entries
      if (rootDoc && sourceType === 'Document') {
        if (!docsMap.has(rootDoc)) {
          docsMap.set(rootDoc, []);
        }
        docsMap.get(rootDoc).push(line);
      } else if (docsMap.has(rootDoc)) {
        // Include related lines for previously registered documents
        docsMap.get(rootDoc).push(line);
      }
    }

    for (const [doc, docLines] of docsMap.entries()) {
      const dot = buildGraph(doc, docLines);
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
