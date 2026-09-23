import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import chalk from 'chalk';

const DEFAULT_RENDER_TYPES = ['PDF'];
const HTML_VIEWPORT = { width: 1440, height: 1000 };
const CLI_ENTRYPOINT = fileURLToPath(new URL('../bin/occs.js', import.meta.url));

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

export function renderTypesFor(test, opts = {}) {
  // `output` is the concise per-test form used by smoke-suite JSON. Keep the
  // older plural forms so existing suites continue to support multi-render runs.
  const configured = test.output ?? test.renderTypes ?? test.outputs ?? opts.renderType ?? DEFAULT_RENDER_TYPES;
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

function pdfPageCount(pdfPath) {
  const result = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  const pages = String(result.stdout || '').match(/^Pages:\s+(\d+)\s*$/m)?.[1];
  return pages ? Number.parseInt(pages, 10) : null;
}

function outputPaths(outputBase, renderTypes) {
  return renderTypes.map((renderType) => `${outputBase}.${renderType === 'PDF' ? 'pdf' : 'html'}`);
}

function targetArgs(target) {
  return target.session ? ['--session', target.session] : ['--tenancy', target.tenancy];
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ error, status: null, stdout, stderr }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function renderPreview({ test, type, id, inputPath, renderTypes, target, opts, previewDir }) {
  const targetId = safeName(target.label, 'target');
  const outputBase = path.join(previewDir, targetId, id);
  const outputs = outputPaths(outputBase, renderTypes);
  const alreadyRendered = opts.resume && outputs.every((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).size > 0);
  const args = [CLI_ENTRYPOINT, 'preview', '--input', inputPath, '--package', test.package, '--output', outputBase, '--render-type', ...renderTypes, ...targetArgs(target)];
  if (opts.effectiveDate) args.push('--effective-date', opts.effectiveDate);
  if (opts.timeout) args.push('--timeout', String(opts.timeout));
  if (opts.verbose) args.push('--verbose');
  const preview = alreadyRendered ? { status: 0, stdout: '', stderr: '' } : await runProcess(process.execPath, args, { cwd: process.cwd() });
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

function compareImages(leftPages, rightPages, outputDir, threshold) {
  if (!leftPages.length || leftPages.length !== rightPages.length) {
    return { status: 'Review', differencePercent: null, reason: 'Rendered page counts differ.' };
  }
  let worstDifference = 0;
  let diffImage = '';
  for (let index = 0; index < leftPages.length; index += 1) {
    const pixels = imagePixels(leftPages[index]);
    if (!pixels || pixels !== imagePixels(rightPages[index])) {
      return { status: 'Review', differencePercent: null, reason: 'Rendered image dimensions differ.' };
    }
    const pageDiff = path.join(outputDir, `diff-page-${index + 1}.png`);
    const result = spawnSync('compare', ['-metric', 'AE', '-fuzz', '3%', leftPages[index], rightPages[index], pageDiff], { encoding: 'utf8' });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return { status: 'Review', differencePercent: null, reason: `Image comparison could not run: ${result.error?.message || result.stderr || 'unknown error'}` };
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

function comparePdfs(leftPdf, rightPdf, outputDir, threshold) {
  const leftPages = createComparisonPages(leftPdf, path.join(outputDir, 'left', 'page'));
  const rightPages = createComparisonPages(rightPdf, path.join(outputDir, 'right', 'page'));
  return compareImages(leftPages, rightPages, outputDir, threshold);
}

function browserExecutable() {
  const candidates = [
    process.env.OCCS_SMOKE_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

async function launchHtmlBrowser() {
  const executablePath = browserExecutable();
  if (!executablePath) {
    throw new Error('Chrome or Chromium was not found. Install one, or set OCCS_SMOKE_BROWSER to its executable path.');
  }
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath, headless: true });
}

async function createHtmlScreenshot(browser, htmlPath, screenshotPath) {
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const context = await browser.newContext({
    viewport: HTML_VIEWPORT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }' });
    await page.evaluate(async () => { await document.fonts?.ready; });
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  } finally {
    await context.close();
  }
}

async function compareHtml(leftHtml, rightHtml, outputDir, threshold, browser) {
  const leftScreenshot = path.join(outputDir, 'left.png');
  const rightScreenshot = path.join(outputDir, 'right.png');
  await Promise.all([
    createHtmlScreenshot(browser, leftHtml, leftScreenshot),
    createHtmlScreenshot(browser, rightHtml, rightScreenshot),
  ]);
  return { ...compareImages([leftScreenshot], [rightScreenshot], outputDir, threshold), leftScreenshot, rightScreenshot };
}

function buildHtmlReport({ target, startedAt, results }) {
  const comparisonMode = results.some((result) => result.comparison);
  const rows = results.map((result) => {
    const thumbnail = result.thumbnail
      ? `<img src="${html(result.thumbnail)}" alt="${html(result.type)} preview" style="max-width:240px;max-height:180px;border:1px solid #bbb">`
      : '<span style="color:#777">No thumbnail</span>';
    const resultLabel = (generated) => generated.status === 'Pass'
      ? `<strong style="color:#157347">Pass${generated.pdfPageCount ? ` (${generated.pdfPageCount} ${generated.pdfPageCount === 1 ? 'page' : 'pages'})` : ''}</strong>`
      : `<strong style="color:#b42318">Fail</strong>${generated.error ? `<br><span style="font-size:12px">${html(generated.error)}</span>` : ''}`;
    const type = `${result.type} (${path.basename(result.input || '')})`;
    if (!comparisonMode) return `<tr><td>${html(type)}</td><td>${html(result.package)}</td><td>${thumbnail}</td><td>${resultLabel(result)}</td></tr>`;
    const compared = result.comparison;
    const otherThumbnail = compared.thumbnail ? `<img src="${html(compared.thumbnail)}" alt="${html(result.type)} ${html(compared.target)} preview" style="max-width:240px;max-height:180px;border:1px solid #bbb">` : '<span style="color:#777">No thumbnail</span>';
    const generated = `${html(result.target)}: ${resultLabel(result)}<br>${html(compared.target)}: ${resultLabel(compared)}`;
    const compare = result.compare.status === 'Pass' ? '<strong style="color:#157347">Pass</strong>' : result.compare.status === 'N/A' ? '<strong>N/A</strong>' : `<strong style="color:#b7791f">Review</strong><br><span style="font-size:12px">${html(result.compare.reason)}</span>`;
    return `<tr><td>${html(type)}</td><td>${html(result.package)}</td><td><div style="font-size:12px;margin-bottom:4px">${html(result.target)}</div>${thumbnail}</td><td><div style="font-size:12px;margin-bottom:4px">${html(compared.target)}</div>${otherThumbnail}</td><td>${generated}</td><td>${compare}</td></tr>`;
  }).join('\n');
  const comparisonTarget = results.find((result) => result.comparison)?.comparison?.target || target;
  const generationResults = comparisonMode ? results.map((result) => result.comparison) : results;
  const generationPassed = generationResults.filter((result) => result?.status === 'Pass').length;
  const generationFailed = generationResults.length - generationPassed;
  const comparisonResults = results.map((result) => result.compare);
  const comparisonPassed = comparisonResults.filter((result) => result?.status === 'Pass').length;
  const comparisonReview = comparisonResults.filter((result) => result?.status === 'Review').length;
  const comparisonFailed = comparisonResults.length - comparisonPassed - comparisonReview;
  const headings = comparisonMode ? `<th style="border:1px solid #333;text-align:left">${html(target)}</th><th style="border:1px solid #333;text-align:left">Comparison</th><th style="border:1px solid #333;text-align:left">Generated</th><th style="border:1px solid #333;text-align:left">Compare</th>` : '<th style="border:1px solid #333;text-align:left">Screenshot</th><th style="border:1px solid #333;text-align:left">Result</th>';
  const heading = comparisonMode
    ? `Comparison Results for the ${html(comparisonTarget)} environment produced on ${html(startedAt)}`
    : `Test Results for the ${html(target)} environment produced on ${html(startedAt)}`;
  const comparisonSummary = comparisonMode
    ? `<br>Comparison - ${comparisonPassed} passed, ${comparisonReview} review, ${comparisonFailed} failed.`
    : '';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111"><p>${heading}</p><p>Results:<br>Generation - ${generationPassed} passed, ${generationFailed} failed.${comparisonSummary}</p><table cellspacing="0" cellpadding="6" style="border-collapse:collapse;border:1px solid #333"><thead><tr><th style="border:1px solid #333;text-align:left">Type</th><th style="border:1px solid #333;text-align:left">Package</th>${headings}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
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

function buildEmailHtml({ target, startedAt, results }) {
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
  return buildHtmlReport({ target, startedAt, results: cidResults });
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
  let htmlBrowser;
  console.log(chalk.cyan(`Running ${suite.tests.length} smoke preview${suite.tests.length === 1 ? '' : 's'} against ${target}${comparisonTarget ? ` and ${comparisonTarget.label}` : ''}...`));

  for (let index = 0; index < suite.tests.length; index += 1) {
    const test = suite.tests[index];
    const type = test.type || test.id || `Test ${index + 1}`;
    if (!test.package || !test.input) {
      results.push({ type, package: test.package || '', input: test.input || '', status: 'Fail', error: 'Suite entry requires both package and input.' });
      continue;
    }
    const inputPath = path.resolve(suiteDir, test.input);
    const id = safeName(test.id || type, `test-${index + 1}`);
    const renderTypes = renderTypesFor(test, opts);
    console.log(`  ${index + 1}/${suite.tests.length} ${type} (${test.package})`);
    const previewOptions = { ...opts, effectiveDate: opts.effectiveDate || suite.effectiveDate };
    const primaryPromise = renderPreview({ test, type, id, inputPath, renderTypes, target: primaryTarget, opts: previewOptions, previewDir });
    const parallelComparisons = Number.parseInt(opts.concurrency, 10) > 1;
    const comparisonPromise = comparisonTarget && parallelComparisons
      ? renderPreview({ test, type, id, inputPath, renderTypes, target: comparisonTarget, opts: previewOptions, previewDir })
      : null;
    const primary = await primaryPromise;
    const result = { type, id, package: test.package, input: inputPath, renderTypes, target: primary.target, outputs: primary.outputs.map((filePath) => path.relative(outputDir, filePath)), status: primary.status, error: primary.error, resumed: primary.resumed };
    const pdfPath = primary.outputs.find((filePath) => filePath.endsWith('.pdf'));
    if (pdfPath && fs.existsSync(pdfPath)) {
      result.pdfPageCount = pdfPageCount(pdfPath);
      const thumbnailPath = path.join(thumbnailDir, `${id}.png`);
      const existingThumbnail = opts.resume && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0;
      if (existingThumbnail || createThumbnail(pdfPath, thumbnailPath)) {
        result.thumbnail = path.relative(outputDir, thumbnailPath);
        result.thumbnailAbsolute = thumbnailPath;
      }
    }
    if (comparisonTarget) {
      const compared = await (comparisonPromise || renderPreview({ test, type, id, inputPath, renderTypes, target: comparisonTarget, opts: previewOptions, previewDir }));
      const comparedPdf = compared.outputs.find((filePath) => filePath.endsWith('.pdf'));
      const htmlPath = primary.outputs.find((filePath) => filePath.endsWith('.html'));
      const comparedHtml = compared.outputs.find((filePath) => filePath.endsWith('.html'));
      result.comparison = { target: compared.target, outputs: compared.outputs.map((filePath) => path.relative(outputDir, filePath)), status: compared.status, error: compared.error, resumed: compared.resumed };
      if (comparedPdf && fs.existsSync(comparedPdf)) {
        result.comparison.pdfPageCount = pdfPageCount(comparedPdf);
        const thumbnailPath = path.join(thumbnailDir, `${id}-${safeName(comparisonTarget.label, 'comparison')}.png`);
        const existingThumbnail = opts.resume && fs.existsSync(thumbnailPath) && fs.statSync(thumbnailPath).size > 0;
        if (existingThumbnail || createThumbnail(comparedPdf, thumbnailPath)) {
          result.comparison.thumbnail = path.relative(outputDir, thumbnailPath);
          result.comparison.thumbnailAbsolute = thumbnailPath;
        }
      }
      if (result.status === 'Pass' && compared.status === 'Pass' && pdfPath && comparedPdf) {
        const comparison = comparePdfs(pdfPath, comparedPdf, path.join(outputDir, 'comparisons', id), comparisonThreshold);
        result.compare = { ...comparison, output: 'PDF', diffImage: comparison.diffImage ? path.relative(outputDir, comparison.diffImage) : '' };
      } else if (result.status === 'Pass' && compared.status === 'Pass' && htmlPath && comparedHtml) {
        try {
          htmlBrowser ||= await launchHtmlBrowser();
          const comparison = await compareHtml(htmlPath, comparedHtml, path.join(outputDir, 'comparisons', id, 'html'), comparisonThreshold, htmlBrowser);
          result.thumbnail = path.relative(outputDir, comparison.leftScreenshot);
          result.thumbnailAbsolute = comparison.leftScreenshot;
          result.comparison.thumbnail = path.relative(outputDir, comparison.rightScreenshot);
          result.comparison.thumbnailAbsolute = comparison.rightScreenshot;
          result.compare = { ...comparison, output: 'HTML', diffImage: comparison.diffImage ? path.relative(outputDir, comparison.diffImage) : '' };
        } catch (error) {
          result.compare = { status: 'Review', output: 'HTML', reason: `HTML visual comparison could not run: ${error.message}` };
        }
      } else {
        result.compare = { status: 'N/A', reason: 'Matching PDF or HTML output was not generated in both environments.' };
      }
    }
    results.push(result);
  }

  await htmlBrowser?.close();

  const reportResults = results.map(({ thumbnailAbsolute, comparison, ...result }) => ({ ...result, comparison: comparison ? (({ thumbnailAbsolute: _, ...value }) => value)(comparison) : undefined }));
  const report = { suite: suite.name || path.basename(suitePath), target, startedAt, runTimestamp, outputDir, summary: { passed: results.filter((result) => result.status === 'Pass').length, failed: results.filter((result) => result.status !== 'Pass').length }, results: reportResults };
  fs.writeFileSync(path.join(outputDir, 'smoke-results.json'), `${JSON.stringify(report, null, 2)}\n`);
  const reportHtml = buildHtmlReport({ target, startedAt, results });
  fs.writeFileSync(path.join(outputDir, 'smoke-report.html'), reportHtml);
  const emailHtml = buildEmailHtml({ target, startedAt, results });
  fs.writeFileSync(path.join(outputDir, 'smoke-email.html'), emailHtml);
  fs.writeFileSync(path.join(outputDir, 'smoke-email.eml'), buildEml({ subject: `Comms Cloud > ${titleCase(target)} Smoke Test > ${startedAt}`, htmlBody: emailHtml, imagePaths: results.flatMap((result) => [result.thumbnailAbsolute, result.comparison?.thumbnailAbsolute]).filter(Boolean) }));

  console.log('');
  console.log(report.summary.failed ? chalk.red(`Smoke complete: ${report.summary.passed} passed, ${report.summary.failed} failed.`) : chalk.green(`Smoke complete: ${report.summary.passed} passed.`));
  console.log(`Output: ${outputDir}`);
  console.log(`Draft email: ${path.join(outputDir, 'smoke-email.eml')}`);
  console.log(`Report: ${path.join(outputDir, 'smoke-report.html')}`);
  process.exitCode = report.summary.failed ? 1 : 0;
}
