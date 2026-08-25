import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const DEFAULT_RENDER_TYPES = ['PDF'];

function readSuite(suitePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read smoke suite ${suitePath}: ${err.message}`);
  }
  if (!Array.isArray(parsed.tests) || parsed.tests.length === 0) {
    throw new Error('Smoke suite must contain a non-empty "tests" array.');
  }
  return parsed;
}

function safeName(value, fallback) {
  const result = String(value || fallback).trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
  return result || fallback;
}

function html(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

function formatSmokeDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('day')} ${value('month')} ${value('year')} ${value('hour')}:${value('minute')} ${value('dayPeriod').toUpperCase()}`;
}

function smokeRunTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

function latestSmokeOutput(outputBase) {
  const directory = path.dirname(outputBase);
  const prefix = `${path.basename(outputBase)}-`;
  const timestampedName = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}-\\d{3}$`);
  if (!fs.existsSync(directory)) return '';
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && timestampedName.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1) || '';
}

function titleCase(value) {
  return String(value ?? '').split(/([\s_-]+)/).map((part) => /^[\s_-]+$/.test(part)
    ? part
    : `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`).join('');
}

function renderTypesFor(test, opts) {
  const configured = test.renderTypes || test.outputs || opts.renderType || DEFAULT_RENDER_TYPES;
  const list = (Array.isArray(configured) ? configured : [configured])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const invalid = list.filter((value) => !['PDF', 'HTML'].includes(value));
  if (invalid.length) throw new Error(`Only PDF and HTML are supported by smoke suites (invalid: ${invalid.join(', ')}).`);
  return [...new Set(list.length ? list : DEFAULT_RENDER_TYPES)];
}

function createThumbnail(pdfPath, thumbnailPath) {
  const prefix = thumbnailPath.replace(/\.png$/i, '');
  const result = spawnSync('pdftoppm', ['-f', '1', '-singlefile', '-png', '-scale-to-x', '480', '-scale-to-y', '-1', pdfPath, prefix], { encoding: 'utf8' });
  return !result.error && result.status === 0 && fs.existsSync(thumbnailPath);
}

function outputPaths(outputBase, renderTypes) {
  return renderTypes.map((renderType) => `${outputBase}.${renderType === 'PDF' ? 'pdf' : 'html'}`);
}

function targetArgs(target) {
  return target.session ? ['--session', target.session] : ['--tenancy', target.tenancy];
}

function renderPreview({ test, type, id, inputPath, renderTypes, target, opts, previewDir }) {
  const targetId = safeName(target.label, 'target');
  const outputBase = path.join(previewDir, targetId, id);
  const outputs = outputPaths(outputBase, renderTypes);
  const alreadyRendered = opts.resume && outputs.every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).size > 0);
  const args = [path.resolve('bin/occs.js'), 'preview', '--input', inputPath, '--package', test.package, '--output', outputBase, '--render-type', ...renderTypes, ...targetArgs(target)];
  if (opts.effectiveDate) args.push('--effective-date', opts.effectiveDate);
  if (opts.timeout) args.push('--timeout', String(opts.timeout));
  if (opts.verbose) args.push('--verbose');
  const preview = alreadyRendered ? { status: 0, stdout: '', stderr: '' } : spawnSync(process.execPath, args, { encoding: 'utf8', cwd: process.cwd() });
  const missing = outputs.filter((filePath) => !fs.existsSync(filePath) || fs.statSync(filePath).size === 0);
  return {
    target: target.label,
    outputs,
    status: preview.error || preview.status !== 0 || missing.length ? 'Fail' : 'Pass',
    error: preview.error || preview.status !== 0 || missing.length
      ? stripAnsi(preview.stderr || preview.stdout || preview.error?.message || `No output generated: ${missing.join(', ')}`).slice(0, 800)
      : '',
    resumed: alreadyRendered,
  };
}

function createComparisonPages(pdfPath, outputPrefix) {
  fs.mkdirSync(path.dirname(outputPrefix), { recursive: true });
  const result = spawnSync('pdftoppm', ['-png', '-scale-to-x', '1000', '-scale-to-y', '-1', pdfPath, outputPrefix], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  const directory = path.dirname(outputPrefix);
  const base = path.basename(outputPrefix);
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(`${base}-`) && name.endsWith('.png'))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => path.join(directory, name));
}

function imagePixels(imagePath) {
  const result = spawnSync('identify', ['-format', '%w %h', imagePath], { encoding: 'utf8' });
  const [width, height] = String(result.stdout || '').trim().split(/\s+/).map(Number);
  return width > 0 && height > 0 ? width * height : 0;
}

function comparePdfs(leftPdf, rightPdf, outputDir, threshold) {
  const leftPages = createComparisonPages(leftPdf, path.join(outputDir, 'left', 'page'));
  const rightPages = createComparisonPages(rightPdf, path.join(outputDir, 'right', 'page'));
  if (!leftPages.length || leftPages.length !== rightPages.length) {
    return { status: 'Review', differencePercent: null, reason: 'Rendered page counts differ.' };
  }
  let worstDifference = 0;
  let diffImage = '';
  for (let index = 0; index < leftPages.length; index += 1) {
    const pixels = imagePixels(leftPages[index]);
    const pageDiff = path.join(outputDir, `diff-page-${index + 1}.png`);
    const result = spawnSync('compare', ['-metric', 'AE', '-fuzz', '3%', leftPages[index], rightPages[index], pageDiff], { encoding: 'utf8' });
    if (result.error) {
      return { status: 'Review', differencePercent: null, reason: `Image comparison could not run: ${result.error.message}` };
    }
    const changedPixels = Number.parseFloat(String(result.stderr || result.stdout || '').match(/[\d.]+/)?.[0] || '0');
    const difference = pixels ? changedPixels / pixels : 1;
    if (difference >= worstDifference) {
      worstDifference = difference;
      diffImage = pageDiff;
    }
  }
  return {
    status: worstDifference <= threshold ? 'Pass' : 'Review',
    differencePercent: worstDifference * 100,
    diffImage: worstDifference > threshold ? diffImage : '',
    reason: worstDifference <= threshold ? '' : `Largest page difference: ${(worstDifference * 100).toFixed(2)}%.`,
  };
}

function buildHtmlReport({ suite, target, startedAt, results, comparisonThreshold = 0.01 }) {
  const comparisonMode = results.some((result) => result.comparison);
  const rows = results.map((result) => {
    const thumbnail = result.thumbnail
      ? `<img src="${html(result.thumbnail)}" alt="${html(result.type)} preview" style="max-width:240px;max-height:180px;border:1px solid #bbb">`
      : '<span style="color:#777">No thumbnail</span>';
    const resultLabel = result.status === 'Pass' ? '<strong style="color:#157347">Pass</strong>' : `<strong style="color:#b42318">Fail</strong><br><span style="font-size:12px">${html(result.error)}</span>`;
    if (!comparisonMode) return `<tr><td>${html(result.type)}</td><td>${html(result.package)}</td><td>${thumbnail}</td><td>${resultLabel}</td></tr>`;
    const compared = result.comparison;
    const otherThumbnail = compared.thumbnail ? `<img src="${html(compared.thumbnail)}" alt="${html(result.type)} ${html(compared.target)} preview" style="max-width:240px;max-height:180px;border:1px solid #bbb">` : '<span style="color:#777">No thumbnail</span>';
    const generated = `${html(result.target)}: ${resultLabel}<br>${html(compared.target)}: ${compared.status === 'Pass' ? '<strong style="color:#157347">Pass</strong>' : `<strong style="color:#b42318">Fail</strong>`}`;
    const compare = result.compare.status === 'Pass' ? '<strong style="color:#157347">Pass</strong>' : result.compare.status === 'N/A' ? '<strong>N/A</strong>' : `<strong style="color:#b7791f">Review</strong><br><span style="font-size:12px">${html(result.compare.reason)}</span>`;
    return `<tr><td>${html(result.type)}</td><td>${html(result.package)}</td><td><div style="font-size:12px;margin-bottom:4px">${html(result.target)}</div>${thumbnail}</td><td><div style="font-size:12px;margin-bottom:4px">${html(compared.target)}</div>${otherThumbnail}</td><td>${generated}</td><td>${compare}</td></tr>`;
  }).join('\n');
  const passed = results.filter((result) => result.status === 'Pass').length;
  const generationSummary = comparisonMode
    ? `${html(target)}: ${passed} passed, ${results.length - passed} failed; ${html(results[0]?.comparison?.target || 'comparison')}: ${results.filter((result) => result.comparison?.status === 'Pass').length} passed, ${results.filter((result) => result.comparison?.status !== 'Pass').length} failed`
    : `${passed} passed, ${results.length - passed} failed`;
  const comparisonSummary = comparisonMode
    ? ` Comparison: ${results.filter((result) => result.compare?.status === 'Pass').length} pass, ${results.filter((result) => result.compare?.status === 'Review').length} review, ${results.filter((result) => result.compare?.status === 'N/A').length} N/A.`
    : '';
  const comparisonFyi = comparisonMode
    ? `<p style="font-size:12px;color:#555">FYI: each PDF page is rasterized and compared with 3% pixel fuzz to ignore minor rendering noise. A result is marked Review when any page exceeds ${(comparisonThreshold * 100).toFixed(2)}% changed pixels.</p>`
    : '';
  const headings = comparisonMode ? `<th style="border:1px solid #333;text-align:left">${html(target)}</th><th style="border:1px solid #333;text-align:left">Comparison</th><th style="border:1px solid #333;text-align:left">Generated</th><th style="border:1px solid #333;text-align:left">Compare</th>` : '<th style="border:1px solid #333;text-align:left">Screenshot</th><th style="border:1px solid #333;text-align:left">Result</th>';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111"><p>Hello Team,</p><p>Please refer to the smoke preview results below for the <strong>${html(target)}</strong> environment.</p><p><strong>Generation:</strong> ${generationSummary}. ${comparisonSummary} · ${html(startedAt)}</p>${comparisonFyi}<table cellspacing="0" cellpadding="6" style="border-collapse:collapse;border:1px solid #333"><thead><tr><th style="border:1px solid #333;text-align:left">Type</th><th style="border:1px solid #333;text-align:left">Package</th>${headings}</tr></thead><tbody>${rows}</tbody></table><p>Thank you for your support.</p></body></html>`;
}

function mimeFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream';
}

function base64MimeLines(filePath) {
  const encoded = fs.readFileSync(filePath).toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') || '';
}

function buildEml({ subject, htmlBody, imagePaths }) {
  const boundary = `=_occs_smoke_${Date.now()}`;
  const messageId = `occs-smoke-${Date.now()}@localhost`;
  const lines = [
    'From: OCCS Smoke Preview <smoke-preview@localhost>',
    'To: Undisclosed recipients:;',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
  ];
  for (const imagePath of imagePaths) {
    const cid = path.basename(imagePath);
    lines.push(`--${boundary}`, `Content-Type: ${mimeFor(imagePath)}; name="${cid}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${cid}>`, `Content-Location: ${cid}`, `Content-Disposition: inline; filename="${cid}"`, '', base64MimeLines(imagePath));
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function buildEmailHtml({ suite, target, startedAt, results, comparisonThreshold }) {
  const cidResults = results.map((result) => ({
    ...result,
    thumbnail: result.thumbnailAbsolute ? `cid:${path.basename(result.thumbnailAbsolute)}` : result.thumbnail,
    comparison: result.comparison ? {
      ...result.comparison,
      thumbnail: result.comparison.thumbnailAbsolute
        ? `cid:${path.basename(result.comparison.thumbnailAbsolute)}`
        : result.comparison.thumbnail,
    } : undefined,
  }));
  return buildHtmlReport({ suite, target, startedAt, results: cidResults, comparisonThreshold });
}

export async function smokeCommand(opts) {
  const suitePath = path.resolve(opts.suite);
  const suite = readSuite(suitePath);
  const suiteDir = path.dirname(suitePath);
  const startedDate = new Date();
  const runTimestamp = smokeRunTimestamp(startedDate);
  const outputBase = path.resolve(opts.output || path.join(suiteDir, 'smoke-output'));
  const previousOutput = opts.resume && latestSmokeOutput(outputBase);
  const outputDir = previousOutput ? path.join(path.dirname(outputBase), previousOutput) : `${outputBase}-${runTimestamp}`;
  const previewDir = path.join(outputDir, 'previews');
  const thumbnailDir = path.join(outputDir, 'thumbnails');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(thumbnailDir, { recursive: true });

  const startedAt = formatSmokeDate(startedDate);
  const target = opts.session || opts.tenancy || suite.session || suite.tenancy || suite.environment || 'configured target';
  const primaryTarget = opts.session || suite.session ? { label: target, session: opts.session || suite.session } : { label: target, tenancy: opts.tenancy || suite.tenancy };
  const comparisonTargetName = opts.compareSession || opts.compareTenancy || suite.compareSession || suite.compareTenancy;
  const comparisonTarget = comparisonTargetName
    ? (opts.compareSession || suite.compareSession ? { label: comparisonTargetName, session: comparisonTargetName } : { label: comparisonTargetName, tenancy: comparisonTargetName })
    : null;
  const comparisonThreshold = Number(opts.compareThreshold ?? suite.compareThreshold ?? 0.01);
  if (!Number.isFinite(comparisonThreshold) || comparisonThreshold < 0 || comparisonThreshold > 1) {
    throw new Error('--compare-threshold must be between 0 and 1 (for example 0.01 for 1%).');
  }
  const results = [];
  console.log(chalk.cyan(`Running ${suite.tests.length} smoke preview${suite.tests.length === 1 ? '' : 's'} against ${target}${comparisonTarget ? ` and ${comparisonTarget.label}` : ''}...`));

  for (let index = 0; index < suite.tests.length; index += 1) {
    const test = suite.tests[index];
    const type = test.type || test.id || `Test ${index + 1}`;
    if (!test.package || !test.input) {
      results.push({ type, package: test.package || '', status: 'Fail', error: 'Suite entry requires both package and input.' });
      continue;
    }
    const inputPath = path.resolve(suiteDir, test.input);
    const id = safeName(test.id || type, `test-${index + 1}`);
    const renderTypes = renderTypesFor(test, opts);
    console.log(`  ${index + 1}/${suite.tests.length} ${type} (${test.package})`);
    const primary = renderPreview({ test, type, id, inputPath, renderTypes, target: primaryTarget, opts: { ...opts, effectiveDate: opts.effectiveDate || suite.effectiveDate }, previewDir });
    const result = { type, id, package: test.package, input: inputPath, renderTypes, target: primary.target, outputs: primary.outputs.map((filePath) => path.relative(outputDir, filePath)), status: primary.status, error: primary.error, resumed: primary.resumed };
    const pdfPath = primary.outputs.find((filePath) => filePath.endsWith('.pdf'));
    if (pdfPath && fs.existsSync(pdfPath)) {
      const thumbnailPath = path.join(thumbnailDir, `${id}.png`);
      if (createThumbnail(pdfPath, thumbnailPath)) {
        result.thumbnail = path.relative(outputDir, thumbnailPath);
        result.thumbnailAbsolute = thumbnailPath;
      }
    }
    if (comparisonTarget) {
      const compared = renderPreview({ test, type, id, inputPath, renderTypes, target: comparisonTarget, opts: { ...opts, effectiveDate: opts.effectiveDate || suite.effectiveDate }, previewDir });
      const comparedPdf = compared.outputs.find((filePath) => filePath.endsWith('.pdf'));
      result.comparison = { target: compared.target, outputs: compared.outputs.map((filePath) => path.relative(outputDir, filePath)), status: compared.status, error: compared.error, resumed: compared.resumed };
      if (comparedPdf && fs.existsSync(comparedPdf)) {
        const thumbnailPath = path.join(thumbnailDir, `${id}-${safeName(comparisonTarget.label, 'comparison')}.png`);
        if (createThumbnail(comparedPdf, thumbnailPath)) {
          result.comparison.thumbnail = path.relative(outputDir, thumbnailPath);
          result.comparison.thumbnailAbsolute = thumbnailPath;
        }
      }
      if (result.status !== 'Pass' || compared.status !== 'Pass' || !pdfPath || !comparedPdf) {
        result.compare = { status: 'N/A', reason: 'A PDF was not generated in both environments.' };
      } else {
        const comparison = comparePdfs(pdfPath, comparedPdf, path.join(outputDir, 'comparisons', id), comparisonThreshold);
        result.compare = { ...comparison, diffImage: comparison.diffImage ? path.relative(outputDir, comparison.diffImage) : '' };
      }
    }
    results.push(result);
  }

  const reportResults = results.map(({ thumbnailAbsolute, comparison, ...result }) => ({ ...result, comparison: comparison ? (({ thumbnailAbsolute: _, ...value }) => value)(comparison) : undefined }));
  const report = { suite: suite.name || path.basename(suitePath), target, startedAt, runTimestamp, outputDir, summary: { passed: results.filter((result) => result.status === 'Pass').length, failed: results.filter((result) => result.status !== 'Pass').length }, results: reportResults };
  fs.writeFileSync(path.join(outputDir, 'smoke-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const reportHtml = buildHtmlReport({ suite, target, startedAt, results, comparisonThreshold });
  fs.writeFileSync(path.join(outputDir, 'smoke-report.html'), reportHtml);
  const emailHtml = buildEmailHtml({ suite, target, startedAt, results, comparisonThreshold });
  fs.writeFileSync(path.join(outputDir, 'smoke-email.html'), emailHtml);
  fs.writeFileSync(path.join(outputDir, 'smoke-email.eml'), buildEml({ subject: `Comms Cloud > ${titleCase(target)} Smoke Test > ${startedAt}`, htmlBody: emailHtml, imagePaths: results.flatMap((result) => [result.thumbnailAbsolute, result.comparison?.thumbnailAbsolute]).filter(Boolean) }));

  console.log('');
  console.log(report.summary.failed ? chalk.red(`Smoke complete: ${report.summary.passed} passed, ${report.summary.failed} failed.`) : chalk.green(`Smoke complete: ${report.summary.passed} passed.`));
  console.log(`Output: ${outputDir}`);
  console.log(`Draft email: ${path.join(outputDir, 'smoke-email.eml')}`);
  console.log(`Report: ${path.join(outputDir, 'smoke-report.html')}`);
  process.exitCode = report.summary.failed ? 1 : 0;
}
