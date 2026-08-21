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

function buildHtmlReport({ suite, target, startedAt, results }) {
  const rows = results.map((result) => {
    const thumbnail = result.thumbnail
      ? `<img src="${html(result.thumbnail)}" alt="${html(result.type)} preview" style="max-width:240px;max-height:180px;border:1px solid #bbb">`
      : '<span style="color:#777">No thumbnail</span>';
    const resultLabel = result.status === 'Pass' ? '<strong style="color:#157347">Pass</strong>' : `<strong style="color:#b42318">Fail</strong><br><span style="font-size:12px">${html(result.error)}</span>`;
    return `<tr><td>${html(result.type)}</td><td>${html(result.package)}</td><td>${thumbnail}</td><td>${resultLabel}</td></tr>`;
  }).join('\n');
  const passed = results.filter((result) => result.status === 'Pass').length;
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111"><p>Hello Team,</p><p>Please refer to the smoke preview results below for the <strong>${html(target)}</strong> environment.</p><p><strong>${passed} passed, ${results.length - passed} failed</strong> · ${html(startedAt)}</p><table cellspacing="0" cellpadding="6" style="border-collapse:collapse;border:1px solid #333"><thead><tr><th style="border:1px solid #333;text-align:left">Type</th><th style="border:1px solid #333;text-align:left">Package</th><th style="border:1px solid #333;text-align:left">Screenshot</th><th style="border:1px solid #333;text-align:left">Result</th></tr></thead><tbody>${rows}</tbody></table><p>Thank you for your support.</p></body></html>`;
}

function mimeFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'application/octet-stream';
}

function buildEml({ subject, htmlBody, imagePaths }) {
  const boundary = `=_occs_smoke_${Date.now()}`;
  const lines = [
    'To:',
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlBody,
  ];
  for (const imagePath of imagePaths) {
    const cid = path.basename(imagePath);
    lines.push(`--${boundary}`, `Content-Type: ${mimeFor(imagePath)}; name="${cid}"`, 'Content-Transfer-Encoding: base64', `Content-ID: <${cid}>`, `Content-Disposition: inline; filename="${cid}"`, '', fs.readFileSync(imagePath).toString('base64'));
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function buildEmailHtml({ suite, target, startedAt, results }) {
  const cidResults = results.map((result) => result.thumbnailAbsolute
    ? { ...result, thumbnail: `cid:${path.basename(result.thumbnailAbsolute)}` }
    : result);
  return buildHtmlReport({ suite, target, startedAt, results: cidResults });
}

export async function smokeCommand(opts) {
  const suitePath = path.resolve(opts.suite);
  const suite = readSuite(suitePath);
  const suiteDir = path.dirname(suitePath);
  const outputDir = path.resolve(opts.output || path.join(suiteDir, 'smoke-output'));
  const previewDir = path.join(outputDir, 'previews');
  const thumbnailDir = path.join(outputDir, 'thumbnails');
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(thumbnailDir, { recursive: true });

  const startedAt = new Date().toLocaleString();
  const target = opts.session || opts.tenancy || suite.session || suite.tenancy || suite.environment || 'configured target';
  const results = [];
  console.log(chalk.cyan(`Running ${suite.tests.length} smoke preview${suite.tests.length === 1 ? '' : 's'} against ${target}...`));

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
    const outputBase = path.join(previewDir, id);
    const outputs = renderTypes.map((renderType) => `${outputBase}.${renderType === 'PDF' ? 'pdf' : 'html'}`);
    const alreadyRendered = opts.resume && outputs.every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).size > 0);
    const args = [path.resolve('bin/occs.js'), 'preview', '--input', inputPath, '--package', test.package, '--output', outputBase, '--render-type', ...renderTypes];
    if (opts.session || suite.session) args.push('--session', opts.session || suite.session);
    else if (opts.tenancy || suite.tenancy) args.push('--tenancy', opts.tenancy || suite.tenancy);
    if (opts.effectiveDate || suite.effectiveDate) args.push('--effective-date', opts.effectiveDate || suite.effectiveDate);
    if (opts.timeout) args.push('--timeout', String(opts.timeout));
    if (opts.verbose) args.push('--verbose');

    console.log(`  ${index + 1}/${suite.tests.length} ${type} (${test.package})${alreadyRendered ? ' (already rendered)' : ''}`);
    const preview = alreadyRendered ? { status: 0, stdout: '', stderr: '' } : spawnSync(process.execPath, args, { encoding: 'utf8', cwd: process.cwd() });
    const missing = outputs.filter((filePath) => !fs.existsSync(filePath) || fs.statSync(filePath).size === 0);
    const result = { type, id, package: test.package, input: inputPath, renderTypes, outputs: outputs.map((filePath) => path.relative(outputDir, filePath)), status: 'Pass', error: '' };
    if (preview.error || preview.status !== 0 || missing.length) {
      result.status = 'Fail';
      result.error = stripAnsi(preview.stderr || preview.stdout || preview.error?.message || `No output generated: ${missing.join(', ')}`).slice(0, 800);
    }
    const pdfPath = outputs.find((filePath) => filePath.endsWith('.pdf'));
    if (pdfPath && fs.existsSync(pdfPath)) {
      const thumbnailPath = path.join(thumbnailDir, `${id}.png`);
      if (createThumbnail(pdfPath, thumbnailPath)) {
        result.thumbnail = path.relative(outputDir, thumbnailPath);
        result.thumbnailAbsolute = thumbnailPath;
      }
    }
    result.resumed = alreadyRendered;
    results.push(result);
  }

  const reportResults = results.map(({ thumbnailAbsolute, ...result }) => result);
  const report = { suite: suite.name || path.basename(suitePath), target, startedAt, summary: { passed: results.filter((result) => result.status === 'Pass').length, failed: results.filter((result) => result.status !== 'Pass').length }, results: reportResults };
  fs.writeFileSync(path.join(outputDir, 'smoke-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const reportHtml = buildHtmlReport({ suite, target, startedAt, results });
  fs.writeFileSync(path.join(outputDir, 'smoke-report.html'), reportHtml);
  const emailHtml = buildEmailHtml({ suite, target, startedAt, results });
  fs.writeFileSync(path.join(outputDir, 'smoke-email.html'), emailHtml);
  fs.writeFileSync(path.join(outputDir, 'smoke-email.eml'), buildEml({ subject: `Smoke preview results — ${target}`, htmlBody: emailHtml, imagePaths: results.map((result) => result.thumbnailAbsolute).filter(Boolean) }));

  console.log('');
  console.log(report.summary.failed ? chalk.red(`Smoke complete: ${report.summary.passed} passed, ${report.summary.failed} failed.`) : chalk.green(`Smoke complete: ${report.summary.passed} passed.`));
  console.log(`Draft email: ${path.join(outputDir, 'smoke-email.eml')}`);
  console.log(`Report: ${path.join(outputDir, 'smoke-report.html')}`);
  process.exitCode = report.summary.failed ? 1 : 0;
}
