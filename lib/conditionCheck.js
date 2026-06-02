import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { JSONPath } from 'jsonpath-plus';

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Failed to parse ${label} JSON at ${filePath}: ${err.message}`);
  }
}

function stripOuterParens(text) {
  let expr = String(text || '').trim();
  while (expr.startsWith('(') && expr.endsWith(')')) {
    let depth = 0;
    let valid = true;
    for (let i = 0; i < expr.length; i += 1) {
      const ch = expr[i];
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth === 0 && i < expr.length - 1) {
        valid = false;
        break;
      }
      if (depth < 0) {
        valid = false;
        break;
      }
    }
    if (!valid) break;
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

function splitTopLevel(expr, operator) {
  const parts = [];
  let current = '';
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;

  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    const next = expr[i + 1];

    if (quote) {
      current += ch;
      if (ch === quote && expr[i - 1] !== '\\') quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '(') depthParen += 1;
    if (ch === ')') depthParen -= 1;
    if (ch === '[') depthBracket += 1;
    if (ch === ']') depthBracket -= 1;

    if (depthParen === 0 && depthBracket === 0 && ch === operator[0] && next === operator[1]) {
      parts.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizePath(expr) {
  const trimmed = String(expr || '').trim();
  if (trimmed.startsWith('@')) return `$${trimmed.slice(1)}`;
  return trimmed;
}

function runJsonPath(json, rawPath) {
  const normalizedPath = normalizePath(rawPath);
  try {
    const values = JSONPath({
      path: normalizedPath,
      json,
      wrap: true,
      preventEval: false,
    });
    return { ok: true, path: normalizedPath, values };
  } catch (err) {
    return { ok: false, path: normalizedPath, values: [], error: err.message };
  }
}

function parseLiteral(valueExpr) {
  const raw = String(valueExpr || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^null$/i.test(raw)) return null;
  return undefined;
}

function evalOperand(json, expr) {
  const literal = parseLiteral(expr);
  if (literal !== undefined) {
    return { kind: 'literal', values: [literal], detail: String(literal) };
  }

  const pathRes = runJsonPath(json, expr);
  if (!pathRes.ok) {
    return {
      kind: 'path',
      values: [],
      error: `JSONPath error for ${pathRes.path}: ${pathRes.error}`,
      detail: 'path-eval-error',
    };
  }

  return {
    kind: 'path',
    values: pathRes.values,
    detail: `${pathRes.path} -> ${JSON.stringify(pathRes.values.slice(0, 3))}${pathRes.values.length > 3 ? '…' : ''}`,
  };
}

function compareValues(op, leftValues, rightValues) {
  const compare = (l, r) => {
    if (op === '==') return l === r;
    if (op === '!=') return l !== r;
    if (op === '<') return Number(l) < Number(r);
    if (op === '>') return Number(l) > Number(r);
    if (op === '<=') return Number(l) <= Number(r);
    if (op === '>=') return Number(l) >= Number(r);
    return false;
  };

  if (!leftValues.length || !rightValues.length) return false;

  if (op === '!=') {
    for (const lv of leftValues) {
      for (const rv of rightValues) {
        if (!compare(lv, rv)) return false;
      }
    }
    return true;
  }

  for (const lv of leftValues) {
    for (const rv of rightValues) {
      if (compare(lv, rv)) return true;
    }
  }
  return false;
}

function getEmptyCheckParentPath(pathExpr) {
  const normalized = normalizePath(pathExpr);
  const filterIdx = normalized.indexOf('[?(');
  if (filterIdx >= 0) {
    return normalized.slice(0, filterIdx).trim();
  }

  const lastDot = normalized.lastIndexOf('.');
  if (lastDot > 0) {
    return normalized.slice(0, lastDot).trim();
  }

  return normalized;
}

function evaluateEmptyCheck(json, fragment, pathExpr, expectEmpty) {
  const parentPath = getEmptyCheckParentPath(pathExpr);
  const parentRes = runJsonPath(json, parentPath);

  if (!parentRes.ok) {
    return {
      passed: false,
      fragment,
      detail: `path error (${parentRes.path}): ${parentRes.error}`,
    };
  }

  if (parentRes.values.length === 0) {
    return {
      passed: false,
      fragment,
      detail: `parent path missing: ${parentRes.path}`,
    };
  }

  const fullRes = runJsonPath(json, pathExpr);
  if (!fullRes.ok) {
    return {
      passed: false,
      fragment,
      detail: `path error (${fullRes.path}): ${fullRes.error}`,
    };
  }

  const isEmpty = fullRes.values.length === 0;
  const passed = expectEmpty ? isEmpty : !isEmpty;

  return {
    passed,
    fragment,
    detail: `${fullRes.path} size=${fullRes.values.length}, expected empty=${expectEmpty}`,
  };
}

function findTopLevelComparison(expr) {
  const text = String(expr || '');
  const operators = ['==', '!=', '<=', '>=', '<', '>'];
  let depthParen = 0;
  let depthBracket = 0;
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '(') depthParen += 1;
    if (ch === ')') depthParen -= 1;
    if (ch === '[') depthBracket += 1;
    if (ch === ']') depthBracket -= 1;

    if (depthParen !== 0 || depthBracket !== 0) {
      continue;
    }

    for (const op of operators) {
      if (text.slice(i, i + op.length) === op) {
        return {
          left: text.slice(0, i).trim(),
          op,
          right: text.slice(i + op.length).trim(),
        };
      }
    }
  }

  return null;
}

function evaluateAtomic(json, rawExpr) {
  const expr = stripOuterParens(rawExpr);
  const emptyMatch = expr.match(/^(.*?)\s+empty\s+(true|false)$/i);
  if (emptyMatch) {
    return evaluateEmptyCheck(json, expr, emptyMatch[1].trim(), emptyMatch[2].toLowerCase() === 'true');
  }

  const cmpMatch = findTopLevelComparison(expr);
  if (cmpMatch) {
    const left = evalOperand(json, cmpMatch.left);
    const right = evalOperand(json, cmpMatch.right);

    if (left.error || right.error) {
      return {
        passed: false,
        fragment: expr,
        detail: left.error || right.error,
      };
    }

    if (!left.values.length || !right.values.length) {
      return {
        passed: false,
        fragment: expr,
        detail: `missing value(s): left=${left.values.length}, right=${right.values.length}`,
      };
    }

    const passed = compareValues(cmpMatch.op, left.values, right.values);
    return {
      passed,
      fragment: expr,
      detail: `left=${JSON.stringify(left.values.slice(0, 3))}${left.values.length > 3 ? '…' : ''}, right=${JSON.stringify(right.values.slice(0, 3))}${right.values.length > 3 ? '…' : ''}`,
    };
  }

  // fallback: treat as JSONPath expression expecting non-empty result
  const res = runJsonPath(json, expr);
  if (!res.ok) {
    return {
      passed: false,
      fragment: expr,
      detail: `path error (${res.path}): ${res.error}`,
    };
  }

  return {
    passed: res.values.length > 0,
    fragment: expr,
    detail: `${res.path} size=${res.values.length}`,
  };
}

function evaluateExpression(json, rawExpr) {
  const expr = stripOuterParens(rawExpr);

  const orParts = splitTopLevel(expr, '||');
  if (orParts.length > 1) {
    const children = orParts.map((part) => evaluateExpression(json, part));
    return {
      passed: children.some((c) => c.passed),
      checks: children.flatMap((c) => c.checks),
      tree: {
        type: 'or',
        passed: children.some((c) => c.passed),
        children: children.map((c) => c.tree),
      },
    };
  }

  const andParts = splitTopLevel(expr, '&&');
  if (andParts.length > 1) {
    const children = andParts.map((part) => evaluateExpression(json, part));
    return {
      passed: children.every((c) => c.passed),
      checks: children.flatMap((c) => c.checks),
      tree: {
        type: 'and',
        passed: children.every((c) => c.passed),
        children: children.map((c) => c.tree),
      },
    };
  }

  const atomic = evaluateAtomic(json, expr);
  return {
    passed: atomic.passed,
    checks: [atomic],
    tree: {
      type: 'atom',
      passed: atomic.passed,
      fragment: atomic.fragment,
      detail: atomic.detail,
    },
  };
}

function extractConditionBody(condition) {
  const raw = String(condition || '').trim();
  const m = raw.match(/^\$\s*\[\s*\?\s*\((.*)\)\s*\]\s*$/s);
  return m ? m[1].trim() : raw;
}

function rankCandidate(docResult) {
  const passedCount = docResult.checks.filter((c) => c.passed).length;
  const total = docResult.checks.length;
  return { passedCount, total, ratio: total ? passedCount / total : 0 };
}

function getClosestCandidates(results) {
  return results
    .filter((r) => !r.triggered)
    .map((r) => ({ r, score: rankCandidate(r) }))
    .sort((a, b) => (b.score.ratio - a.score.ratio) || (b.score.passedCount - a.score.passedCount));
}

function printClosestMatchesMd(results) {
  const candidates = getClosestCandidates(results);

  if (!candidates.length) return;

  console.log('\n## Closest Matches\n');
  console.log('| Candidate $$Id | Passed checks | Failed checks |');
  console.log('|---|---|---|');

  for (const { r } of candidates.slice(0, 10)) {
    const passed = r.checks.filter((c) => c.passed).map((c) => `\`${c.fragment}\``).join('; ') || 'None';
    const failed = r.checks.filter((c) => !c.passed).map((c) => `\`${c.fragment}\` (${c.detail})`).join('; ') || 'None';
    console.log(`| \`${r.docId}\` | ${passed} | ${failed} |`);
  }
}

function printClosestMatchesPretty(results) {
  const candidates = getClosestCandidates(results);
  if (!candidates.length) return;

  console.log(`\n${chalk.yellow('Closest matches:')}`);
  for (const { r, score } of candidates.slice(0, 10)) {
    const header = score.passedCount > 0
      ? chalk.yellow(`- ${r.docId} (${score.passedCount}/${score.total} checks passed)`)
      : chalk.red(`- ${r.docId} (${score.passedCount}/${score.total} checks passed)`);
    console.log(header);
    const failed = r.checks.filter((c) => !c.passed).slice(0, 3);
    for (const check of failed) {
      console.log(chalk.red(`  fail: ${check.fragment} -> ${check.detail}`));
    }
  }
}

function getContentPathId(item) {
  return `${item.docId} / ${item.layoutId} / ${item.contentId}`;
}

function simplifyConditionFragment(fragment) {
  let text = String(fragment || '').trim();
  text = text.replace(/^[@$]\./, '');
  text = text.replace(/^billPrint\.billDetails\.cmElements\./, '');
  text = text.replace(/^billPrint\./, '');
  text = text.replace(/\s+/g, ' ');
  return text;
}

function formatCheckDetail(detail) {
  const text = String(detail || '').trim();
  if (!text) return 'actual value: (none)';

  const lrMatch = text.match(/left=([^,]+),\s*right=/i);
  if (lrMatch) {
    const actual = lrMatch[1].trim().replace(/^\[|\]$/g, '');
    return `actual value: ${actual}`;
  }

  const sizeMatch = text.match(/size=(\d+),\s*expected empty=(true|false)/i);
  if (sizeMatch) {
    const size = Number(sizeMatch[1]);
    const empty = size === 0;
    return `actual value: empty=${empty}/size ${size}`;
  }

  if (/parent path missing/i.test(text)) {
    return 'actual value: missing parent path';
  }

  return `actual value: ${text}`;
}

function countChecksInTree(node) {
  if (!node) return { pass: 0, total: 0 };
  if (node.type === 'atom') {
    return { pass: node.passed ? 1 : 0, total: 1 };
  }

  const children = Array.isArray(node.children) ? node.children : [];
  return children.reduce(
    (acc, child) => {
      const childCounts = countChecksInTree(child);
      return {
        pass: acc.pass + childCounts.pass,
        total: acc.total + childCounts.total,
      };
    },
    { pass: 0, total: 0 },
  );
}

function renderConditionTreeLines(node, indent = '  ', label = '') {
  if (!node) return [];

  if (node.type === 'atom') {
    const prefix = label ? `${label}: ` : '';
    const fragment = simplifyConditionFragment(node.fragment);
    if (node.passed) {
      return [{
        level: 'pass',
        text: `${indent}pass: ${prefix}${fragment}`,
      }];
    }
    return [{
      level: 'fail',
      text: `${indent}fail: ${prefix}${fragment} -> ${formatCheckDetail(node.detail)}`,
    }];
  }

  const counts = countChecksInTree(node);
  const nodeType = String(node.type || 'group').toUpperCase();
  const labelPrefix = label ? `${label} ` : '';
  const headerLevel = node.passed ? 'pass' : 'fail';
  const lines = [{
    level: headerLevel,
    text: `${indent}${labelPrefix}${nodeType}: ${node.passed ? 'pass' : 'fail'} (${counts.pass}/${counts.total} checks passed)`,
  }];

  const children = Array.isArray(node.children) ? node.children : [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    const childLabel = node.type === 'or' ? `branch ${i + 1}` : `clause ${i + 1}`;
    lines.push(...renderConditionTreeLines(child, `${indent}  `, childLabel));
  }

  return lines;
}

function printContentResultsPretty(contentResults, userThreshold) {
  if (!contentResults.length) return;

  const triggered = contentResults.filter((r) => r.triggered);
  const notTriggered = contentResults.filter((r) => !r.triggered);
  console.log(chalk.cyan('\nLayout/Content condition results:'));
  console.log(chalk.cyan(`Conditioned content items evaluated: ${contentResults.length}`));

  if (triggered.length) {
    console.log(chalk.green(`Triggered content items (${triggered.length}):`));
    for (const item of triggered) {
      console.log(chalk.green(`- ${getContentPathId(item)}`));
      const checks = item.checks.filter((c) => c.passed).slice(0, 2);
      for (const check of checks) {
        console.log(chalk.green(`  pass: ${check.fragment}`));
      }
    }
  } else {
    console.log(chalk.yellow('Triggered content items (0):'));
    console.log(chalk.yellow('- none'));
  }

  if (notTriggered.length) {
    const ranked = getClosestCandidates(contentResults);
    console.log(chalk.yellow('\nContent items not triggered:'));
    for (const { r, score } of ranked.slice(0, 20)) {
      if (r.triggered) continue;
      console.log(chalk.yellow(`- ${getContentPathId(r)} (${score.passedCount}/${score.total} checks passed)`));
      if (r.tree) {
        const lines = renderConditionTreeLines(r.tree, '  ');
        for (const line of lines.slice(0, 12)) {
          if (line.level === 'pass') {
            console.log(chalk.green(line.text));
          } else if (line.level === 'fail') {
            console.log(chalk.red(line.text));
          } else {
            console.log(chalk.yellow(line.text));
          }
        }
      } else {
        const passed = r.checks.filter((c) => c.passed).slice(0, 2);
        const failed = r.checks.filter((c) => !c.passed).slice(0, 3);
        for (const check of passed) {
          console.log(chalk.green(`  pass: ${simplifyConditionFragment(check.fragment)}`));
        }
        for (const check of failed) {
          console.log(chalk.red(`  fail: ${simplifyConditionFragment(check.fragment)} -> ${formatCheckDetail(check.detail)}`));
        }
      }
    }
  }
}

function parseNearMissThreshold(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null;
  }
  const text = String(raw).trim();
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) {
    throw new Error('Invalid --near-miss-threshold. Use a number like 0.6 or 60.');
  }
  const value = numeric > 1 ? numeric / 100 : numeric;
  if (value <= 0 || value > 1) {
    throw new Error('Invalid --near-miss-threshold. Valid range is > 0 and <= 1 (or 0-100%).');
  }
  return value;
}

function getDynamicNearMissThreshold(totalChecks) {
  // Stricter for small condition sets:
  // 2 checks -> effectively 100%; 3 checks -> ~67%; 4+ checks -> 50%.
  if (totalChecks <= 2) return 1.0;
  if (totalChecks === 3) return 2 / 3;
  return 0.5;
}

function qualifiesAsNearMiss(score, userThreshold) {
  if (!score || score.total <= 0) return false;
  if (score.passedCount <= 0) return false;
  if (score.passedCount >= score.total) return false;

  const threshold = Math.max(
    getDynamicNearMissThreshold(score.total),
    userThreshold ?? 0,
  );

  return score.ratio >= threshold;
}

function printNearMissesPretty(results, limit = 8, userThreshold = null) {
  const candidates = getClosestCandidates(results).filter(({ r, score }) => {
    if (!qualifiesAsNearMiss(score, userThreshold)) return false;
    const failedChecks = r.checks.filter((c) => !c.passed);
    const rateSchedFailures = failedChecks.filter((c) =>
      /ratesched/i.test(String(c.fragment || '')) || /ratesched/i.test(String(c.detail || '')),
    );

    // Exclude only pure rateSched misses. If there are additional non-rateSched
    // failures, keep the candidate so useful debugging evidence remains visible.
    return !(failedChecks.length > 0 && rateSchedFailures.length === failedChecks.length);
  });
  if (!candidates.length) return;

  console.log(`\n${chalk.yellow('Near misses (almost triggered):')}`);
  for (const { r, score } of candidates.slice(0, limit)) {
    console.log(chalk.yellow(`- ${r.docId} (${score.passedCount}/${score.total} checks passed)`));

    const passed = r.checks.filter((c) => c.passed).slice(0, 3);
    const failed = r.checks.filter((c) => !c.passed).slice(0, 3);

    for (const check of passed) {
      console.log(chalk.green(`  pass: ${check.fragment}`));
    }
    for (const check of failed) {
      console.log(chalk.red(`  fail: ${check.fragment} -> ${check.detail}`));
    }
  }
}

function extractSampleSignal(detail) {
  const text = String(detail || '').trim();
  if (!text) return '(none)';

  const lrMatch = text.match(/left=([^,]+),\s*right=/i);
  if (lrMatch) {
    const raw = lrMatch[1].trim();
    return raw.replace(/^\[|\]$/g, '');
  }

  const sizeMatch = text.match(/size=(\d+)/i);
  if (sizeMatch) {
    return `size=${sizeMatch[1]}`;
  }

  if (/parent path missing/i.test(text)) {
    return 'missing parent path';
  }

  if (/path error/i.test(text)) {
    return 'path error';
  }

  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function summarizeConditionChecks(results, limit = 10) {
  const map = new Map();

  for (const r of results) {
    for (const check of r.checks || []) {
      const key = String(check.fragment || '').trim() || '(unknown)';
      if (!map.has(key)) {
        map.set(key, {
          fragment: key,
          pass: 0,
          fail: 0,
          sampleSignal: '(none)',
        });
      }
      const entry = map.get(key);
      if (check.passed) {
        entry.pass += 1;
      } else {
        entry.fail += 1;
      }
      if (entry.sampleSignal === '(none)' && check.detail) {
        entry.sampleSignal = extractSampleSignal(check.detail);
      }
    }
  }

  return [...map.values()]
    .sort((a, b) => (b.fail - a.fail) || (b.pass - a.pass) || a.fragment.localeCompare(b.fragment))
    .slice(0, limit);
}

function printHighLevelSummaryPretty(results, triggered) {
  const summary = summarizeConditionChecks(results, 12);
  if (!summary.length) return;

  console.log(chalk.cyan('\nHigh-level check summary:'));
  console.log('Check'.padEnd(62) + 'Sample/Evidence'.padEnd(24) + 'Pass'.padStart(6) + 'Fail'.padStart(6));
  console.log('-'.repeat(98));

  for (const item of summary) {
    const checkCol = item.fragment.length > 60 ? `${item.fragment.slice(0, 57)}...` : item.fragment;
    const sampleCol = item.sampleSignal.length > 22 ? `${item.sampleSignal.slice(0, 19)}...` : item.sampleSignal;
    const row =
      checkCol.padEnd(62) +
      sampleCol.padEnd(24) +
      String(item.pass).padStart(6) +
      String(item.fail).padStart(6);
    if (item.fail > 0 && item.pass === 0) {
      console.log(chalk.red(row));
    } else if (item.fail > 0) {
      console.log(chalk.yellow(row));
    } else {
      console.log(chalk.green(row));
    }
  }

  if (!triggered.length) {
    const top = getClosestCandidates(results)[0];
    if (top) {
      console.log(chalk.yellow(`\nClosest non-trigger path: ${top.r.docId} (${top.score.passedCount}/${top.score.total} checks passed)`));
    }
  }
}

function resolveFormat(rawFormat) {
  const format = String(rawFormat || 'pretty').trim().toLowerCase();
  if (!['pretty', 'md', 'json'].includes(format)) {
    throw new Error(`Invalid format: ${rawFormat}. Valid values: pretty, md, json`);
  }
  return format;
}

function evaluateConditionTarget(targetId, condition, sample) {
  const expression = extractConditionBody(condition);
  const evalResult = evaluateExpression(sample, expression);
  return {
    targetId,
    condition,
    triggered: evalResult.passed,
    checks: evalResult.checks,
    tree: evalResult.tree,
  };
}

function resolveAssemblyTemplatePath(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return path.resolve('');
  }

  const hasPathOrExtension = /[\\/]/.test(raw) || path.extname(raw);
  if (hasPathOrExtension) {
    return path.resolve(raw);
  }

  return path.resolve(process.cwd(), `${raw}.json`);
}

export async function conditionCheckCommand(opts) {
  const atPath = resolveAssemblyTemplatePath(opts.package);
  const inputPath = path.resolve(String(opts.input || ''));

  if (!opts.package || !fs.existsSync(atPath)) {
    console.error(chalk.red(`❌ Assembly Template JSON not found: ${atPath}`));
    process.exit(1);
  }
  if (!opts.input || !fs.existsSync(inputPath)) {
    console.error(chalk.red(`❌ Input JSON not found: ${inputPath}`));
    process.exit(1);
  }

  let template;
  let sample;
  try {
    template = readJsonFile(atPath, 'Assembly Template');
    sample = readJsonFile(inputPath, 'Input');
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }

  const docs = Array.isArray(template?.Documents) ? template.Documents : [];
  if (!docs.length) {
    console.error(chalk.red('❌ Assembly Template has no Documents array.'));
    process.exit(1);
  }
  let format;
  try {
    format = resolveFormat(opts.format);
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }
  let nearMissThreshold;
  try {
    nearMissThreshold = parseNearMissThreshold(opts.nearMissThreshold);
  } catch (err) {
    console.error(chalk.red(`❌ ${err.message}`));
    process.exit(1);
  }
  if (nearMissThreshold === null) {
    nearMissThreshold = 0.65;
  }

  const results = docs.map((doc, index) => {
    const docId = doc?.['$$Id'] || `Documents[${index}]`;
    const condition = String(doc?.Condition || '').trim();

    if (!condition) {
      return {
        docId,
        condition,
        triggered: true,
        checks: [{ passed: true, fragment: '(no condition)', detail: 'unconditional' }],
      };
    }

    return {
      docId,
      ...evaluateConditionTarget(docId, condition, sample),
    };
  });

  const triggered = results.filter((r) => r.triggered).map((r) => r.docId);
  const triggeredSet = new Set(triggered);

  const contentResults = [];
  for (let d = 0; d < docs.length; d += 1) {
    const doc = docs[d];
    const docId = doc?.['$$Id'] || `Documents[${d}]`;
    if (!triggeredSet.has(docId)) continue;

    const layouts = Array.isArray(doc?.Layouts) ? doc.Layouts : [];
    for (let l = 0; l < layouts.length; l += 1) {
      const layout = layouts[l];
      const layoutId = layout?.['$$Id'] || `Layouts[${l}]`;
      const contents = Array.isArray(layout?.Contents) ? layout.Contents : [];
      for (let c = 0; c < contents.length; c += 1) {
        const content = contents[c];
        const condition = String(content?.Condition || '').trim();
        if (!condition) continue;
        const contentId = content?.['$$Id'] || `Contents[${c}]`;
        const targetId = `${docId} / ${layoutId} / ${contentId}`;
        const evaluated = evaluateConditionTarget(targetId, condition, sample);
        contentResults.push({
          docId,
          layoutId,
          contentId,
          ...evaluated,
        });
      }
    }
  }

  const payload = {
    templateFile: atPath,
    sampleFile: inputPath,
    templateId: template?.['$$Id'] || null,
    triggeredDocumentIds: triggered,
    documentResults: results,
    contentResults,
  };

  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (format === 'md') {
    console.log(`Template file: ${atPath}`);
    console.log(`Sample file: ${inputPath}`);
    console.log(`Template $$Id: ${template?.['$$Id'] || '(unknown)'}`);
    console.log('\n## Triggered Document IDs\n');

    if (triggered.length) {
      for (const id of triggered) {
        console.log(`- \`${id}\``);
      }
    } else {
      console.log('None.');
    }

    console.log('\n| Document $$Id | Key passing checks |');
    console.log('|---|---|');
    for (const r of results) {
      if (!r.triggered) continue;
      const passedChecks = r.checks.filter((c) => c.passed).map((c) => `\`${c.fragment}\``).join('; ') || '`(none)`';
      console.log(`| \`${r.docId}\` | ${passedChecks} |`);
    }

    if (contentResults.length) {
      console.log('\n## Triggered Content IDs (Within Triggered Documents)\n');
      const triggeredContent = contentResults.filter((r) => r.triggered);
      if (!triggeredContent.length) {
        console.log('None.');
      } else {
        for (const item of triggeredContent) {
          console.log(`- \`${item.docId} / ${item.layoutId} / ${item.contentId}\``);
        }
      }
    }

    if (!triggered.length) {
      printClosestMatchesMd(results);
    }
    return;
  }

  console.log(chalk.cyan(`Template: ${atPath}`));
  console.log(chalk.cyan(`Input:    ${inputPath}`));
  console.log(chalk.cyan(`Template ID: ${template?.['$$Id'] || '(unknown)'}`));
  console.log(
    triggered.length
      ? chalk.green(`\nTriggered documents (${triggered.length}):`)
      : chalk.yellow('\nTriggered documents (0):'),
  );
  if (!triggered.length) {
    console.log(chalk.yellow('- none'));
  } else {
    for (const id of triggered) {
      console.log(chalk.green(`- ${id}`));
    }
  }

  if (triggered.length) {
    console.log(chalk.cyan('\nTriggered evidence:'));
    const unconditional = results
      .filter((x) => x.triggered && (!x.condition || !String(x.condition).trim()))
      .map((x) => x.docId);
    if (unconditional.length) {
      console.log(chalk.green(`Unconditional triggers: ${unconditional.join(', ')}`));
    }
    for (const r of results.filter((x) => x.triggered)) {
      const checks = r.checks.filter((c) => c.passed).map((c) => c.fragment).slice(0, 3);
      console.log(chalk.green(`- ${r.docId}`));
      for (const chk of checks) {
        console.log(chalk.green(`  pass: ${chk}`));
      }
      if (!checks.length) {
        console.log(chalk.green('  pass: (unconditional)'));
      }
    }

    if (opts.showCheckSummary) {
      printHighLevelSummaryPretty(results, triggered);
    }
    printNearMissesPretty(results, 8, nearMissThreshold);
    printContentResultsPretty(contentResults, nearMissThreshold);
  } else {
    if (opts.showCheckSummary) {
      printHighLevelSummaryPretty(results, triggered);
    }
    printClosestMatchesPretty(results);
  }
}
