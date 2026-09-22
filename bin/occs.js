#!/usr/bin/env node
import { Command } from 'commander';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'node:module';
import loginCommand from '../lib/auth.js';
import { documentCatalogCommand, getDocumentCommand, listDocumentsCommand } from '../lib/documents.js';
import { getPackageCommand, listPackagesCommand } from '../lib/packages.js';
import { getLayoutCommand, listLayoutsCommand } from '../lib/layouts.js';
import { getContentCommand, listContentsCommand } from '../lib/contents.js';
import { getStyleCommand, listStylesCommand } from '../lib/styles.js';
import { getChartCommand, listChartsCommand } from '../lib/charts.js';
import { getFontCommand, listFontsCommand } from '../lib/fonts.js';
import { packageGetCommand, packageListCommand, packageSaveCommand } from '../lib/packageMaintenance.js';
import { catalogCommand } from '../lib/catalog.js';
import { crossrefCommand } from '../lib/crossRef.js';
import { graphCommand } from '../lib/graph.js';
import { mockupCommand } from '../lib/mockup.js';
import { listCompaniesCommand } from '../lib/companies.js';
import { listConfigsCommand } from '../lib/configs.js';
import { preflightCommand } from '../lib/preflight.js';
import { closeConfigCommand, createConfigCommand, migrateCommand } from '../lib/migration.js';
import { convertXmlCommand, previewCommand } from '../lib/preview.js';
import { conditionCheckCommand } from '../lib/conditionCheck.js';
import { smokeCommand } from '../lib/smoke.js';
import { templateCompareCommand } from '../lib/templateCompare.js';
import { consumeRuntimeCompletionContext, startRuntimeCounter, stopRuntimeCounter } from '../lib/runtimeCounter.js';
import { sessionsCommand, useSessionCommand } from '../lib/sessionCommands.js';
import { setJsonPretty } from '../lib/utils.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, setDefaultRequestTimeoutMs } from '../lib/requestTimeout.js';
import { ExportResumeState } from '../lib/exportResume.js';
import path from 'path';

const require = createRequire(import.meta.url);
const { version: CLI_VERSION } = require('../package.json');
const program = new Command();

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function escapeAppleScriptString(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function toPowerShellString(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function buildCompletionNotificationBody(commandName, elapsedSeconds, context) {
  const contextSuffix = context ? ` (${context})` : '';
  const elapsedSuffix = elapsedSeconds ? ` in ${elapsedSeconds}s` : '';
  return `${commandName} completed${contextSuffix}${elapsedSuffix}`;
}

function playCompletionSound() {
  if (process.platform === 'darwin') {
    return runCommand('afplay', ['/System/Library/Sounds/Glass.aiff']);
  }

  if (process.platform === 'win32') {
    return runCommand('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      '[System.Media.SystemSounds]::Asterisk.Play()',
    ]);
  }

  return runCommand('canberra-gtk-play', ['-i', 'complete'])
    || runCommand('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga']);
}

function showCompletionNotification(commandName, elapsedSeconds, context) {
  const title = 'OCCS CLI';
  const body = buildCompletionNotificationBody(commandName, elapsedSeconds, context);

  if (process.platform === 'darwin') {
    const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`;
    const notified = runCommand('osascript', ['-e', script]);
    const sounded = playCompletionSound();
    return notified || sounded;
  }

  if (process.platform === 'win32') {
    const script = [
      `Add-Type -AssemblyName System.Windows.Forms`,
      `Add-Type -AssemblyName System.Drawing`,
      `$notification = New-Object System.Windows.Forms.NotifyIcon`,
      `$notification.Icon = [System.Drawing.SystemIcons]::Information`,
      `$notification.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info`,
      `$notification.BalloonTipTitle = ${toPowerShellString(title)}`,
      `$notification.BalloonTipText = ${toPowerShellString(body)}`,
      `$notification.Visible = $true`,
      `$notification.ShowBalloonTip(5000)`,
      `Start-Sleep -Milliseconds 5500`,
      `$notification.Dispose()`,
    ].join('; ');
    const sounded = playCompletionSound();
    return spawnDetached('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script]) || sounded;
  }

  const notified = runCommand('notify-send', [title, body]);
  const sounded = playCompletionSound();
  return notified || sounded;
}

function showBanner() {
  console.log('');
  console.log(`OCCS CLI ${CLI_VERSION} 🚀`);
  console.log('');
}

function collectCsvOption(value, previous = []) {
  return [
    ...previous,
    ...String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ];
}

program
  .name('occs')
  .description('Oracle CCS CLI utility')
  .version(CLI_VERSION)
  .option('--notify', 'Show a desktop notification and play a sound after successful command execution')
  .option('--pretty', 'Pretty-print JSON output and preserve JSON string whitespace')
  .option('--concurrency <n>', 'Maximum concurrent OCCS export requests (default 4)', '4')
  .option('--timeout <ms>', `Default HTTP request timeout in milliseconds (default ${DEFAULT_REQUEST_TIMEOUT_MS})`);

program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand?.optsWithGlobals?.() || {};
  setJsonPretty(opts.pretty || process.argv.includes('--pretty'));
  setDefaultRequestTimeoutMs(opts.timeout);
  if (opts.json) {
    return;
  }
  const commandName = actionCommand?.name?.() || 'command';
  startRuntimeCounter(`Running ${commandName}...`);
});

program.hook('postAction', (_thisCommand, actionCommand) => {
  const elapsedSeconds = stopRuntimeCounter();
  const commandName = actionCommand?.name?.() || 'command';
  const context = consumeRuntimeCompletionContext();
  const opts = actionCommand.optsWithGlobals();
  if (opts?.json) {
    return;
  }
  if (elapsedSeconds) {
    const contextSuffix = context ? ` (${context})` : '';
    console.log(`Completed ${commandName}${contextSuffix} in ${elapsedSeconds}s`);
  }
  if (opts?.notify) {
    const didNotify = showCompletionNotification(commandName, elapsedSeconds, context);
    if (!didNotify) {
      console.warn('Notification requested, but no supported desktop notifier or sound command was available.');
    }
  }
});

process.on('exit', () => {
  stopRuntimeCounter();
});

program
  .command('list-companies')
  .description('Generate list of companies')
  .option('-o, --output <dir>', 'Path to output folder')  
  .action(listCompaniesCommand);

program
  .command('list-configs')
  .description('Generate list of open configuration IDs')
  .option('-o, --output <dir>', 'Path to output folder')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .option('--timeout <ms>', `Request timeout in milliseconds for config list calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .action(listConfigsCommand);

program
  .command('preflight')
  .description('Scan open ConfigIDs for in-flight records')
  .option('-c, --config-id <id>', 'Only scan a single ConfigID from the open configuration list')
  .option('--list-attached', 'List attached package/document/content items for each scanned ConfigID')
  .option('--show-blockers', 'Show package->document blocker chains, including owner config details when available')
  .option('-o, --output <dir>', 'Path to output folder', './output/preflight')
  .option('-v, --verbose', 'Verbose logging')
  .action(preflightCommand);

program
  .command('close-config [configId]')
  .description('Mark a ConfigId as Closed')
  .option('--config-id <nameOrId>', 'ConfigId name, short name, internal id, or UUID')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .option('--dry-run', 'Resolve and report the close request without sending it')
  .option('--force', 'Submit the close request even if the current ConfigId status is not Open')
  .option('--timeout <ms>', `Request timeout in milliseconds for close calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(closeConfigCommand);

program
  .command('create-config [shortName]')
  .description('Create an open ConfigId')
  .option('--short-name <shortName>', 'ConfigId short name; defaults to positional shortName')
  .option('--name <name>', 'ConfigId long name; defaults to short name')
  .option('--desc <description>', 'ConfigId description')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .option('--dry-run', 'Build and report the create request without sending it')
  .option('--timeout <ms>', `Request timeout in milliseconds for create calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(createConfigCommand);

program
  .command('migrate [configId]')
  .description('Initiate ConfigId movement from a source environment to a target environment')
  .option('--config-id <nameOrId>', 'Optional ConfigId to verify is present in the eligible movement list')
  .option('--source-session <name>', 'Saved source session alias or key')
  .option('--source-customer <customer>', 'Source customer short name for saved-session lookup')
  .option('--source-region <region>', 'Source Oracle region for saved-session lookup')
  .option('--source-environment <environment>', 'Source Oracle environment for saved-session lookup (alias for source region)')
  .option('--source-tenancy <tenancy>', 'Source tenancy path for saved-session lookup')
  .option('--source-token <token>', 'Source environment access token; accepts raw token or "Bearer ..."')
  .option('--use-stored-source-token', 'Use the saved source session token instead of refreshing from stored credentials')
  .option('--target-session <name>', 'Saved target session alias or key; defaults to the current session')
  .option('--target-customer <customer>', 'Target customer short name for saved-session lookup')
  .option('--target-region <region>', 'Target Oracle region for saved-session lookup')
  .option('--target-environment <environment>', 'Target Oracle environment for saved-session lookup (alias for target region)')
  .option('--target-tenancy <tenancy>', 'Target tenancy path for saved-session lookup')
  .option('--dry-run', 'Fetch and validate the eligible movement list without initiating movement')
  .option('--force', 'Initiate even if the target movement monitor reports a busy status')
  .option('--timeout <ms>', `Request timeout in milliseconds for movement API calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--token-timeout <ms>', `Request timeout in milliseconds for source token refresh (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(migrateCommand);

program
  .command('preview')
  .description('Render a communication package preview or submit an email from input JSON or XML')
  .requiredOption('-i, --input <path>', 'Input JSON/XML file path, or folder of JSON files')
  .option('-p, --package <name>', 'Communication package short name (required except for EMAIL-only requests)')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .option('--env-file <path>', 'Path to .env file for credential defaults')
  .option('--extract <expr>', 'For XML batches, extract a single record by expression (e.g. billId=002051606115)')
  .option('--xsd <path>', 'Convert locally using this XSD instead of the Oracle XML-to-JSON API')
  .option('--reroot <newRoot>', 'For XML input, reroot converted JSON to this element before preview (defaults to billPrint)')
  .option('--disable-reroot', 'For XML input, disable converted JSON rerooting (overrides the default billPrint reroot)')
  .option('--timeout <ms>', `Request timeout in milliseconds for preview/converter calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('-e, --effective-date <date>', 'Effective date (YYYY-MM-DD), defaults to today')
  .option('-d, --debug [nameAndValue...]', 'Inject debug key/value into JSON input. Defaults: name=DEBUGCOMMS value=1')
  .option('-r, --render-type <type...>', 'Render type(s): PDF, HTML, TEXT, CSV, JSON, METADATA, EMAIL (supports comma or space separated values)', ['PDF'])
  .option('--email-config-uuid <uuid>', 'Email communication configuration UUID (or OCCS_EMAIL_CONFIG_UUID)')
  .option('--recipient <email>', 'Override email recipient; repeat or comma-separate values', (value, previous = []) => [...previous, value], [])
  .option('--send-email', 'Submit EMAIL to Comms; otherwise report the email that would be sent')
  .option('-o, --output <path>', 'Output file path (or directory)')
  .option('-v, --verbose', 'Verbose logging')
  .action(previewCommand);

program
  .command('smoke')
  .description('Run package previews from a suite and create an unsent email draft')
  .requiredOption('-s, --suite <file>', 'Smoke suite JSON file')
  .option('--session <name>', 'Saved session alias or key to use (overrides suite session)')
  .option('--tenancy <tenancy>', 'Saved-session tenancy to use (for example, non-prod)')
  .option('--compare-session <name>', 'Second saved session alias or key for visual comparison')
  .option('--compare-tenancy <tenancy>', 'Second tenancy for visual comparison (for example, pre-prod)')
  .option('--compare-threshold <fraction>', 'Maximum changed-pixel fraction for comparison Pass (default 0.01)')
  .option('-o, --output <dir>', 'Output directory base (a date/time suffix is added; default: smoke-output beside the suite)')
  .option('--resume', 'Resume the most recent matching date/time-stamped output folder, rendering only missing entries')
  .option('-r, --render-type <type...>', 'Default render types for tests without renderTypes (PDF, HTML)', ['PDF'])
  .option('-e, --effective-date <date>', 'Effective date (YYYY-MM-DD)')
  .option('--timeout <ms>', `Request timeout in milliseconds (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--concurrency <n>', 'Maximum simultaneous primary/comparison previews (default 2)', '2')
  .option('-v, --verbose', 'Include preview request detail')
  .action(smokeCommand);

program
  .command('convertxml')
  .description('Convert XML input to JSON using Oracle CCS')
  .requiredOption('-i, --input <path>', 'Input XML file path, or folder of XML files')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .option('--env-file <path>', 'Path to .env file for credential defaults')
  .option('--extract <expr>', 'For XML batches, extract a single record by expression from each XML file (e.g. billId=002051606115)')
  .option('--xsd <path>', 'Convert locally using this XSD instead of the Oracle XML-to-JSON API')
  .option('--reroot <newRoot>', 'Reroot converted JSON to this element (defaults to billPrint)')
  .option('--disable-reroot', 'Disable converted JSON rerooting (overrides the default billPrint reroot)')
  .option('--preserveNL', 'Preserve newline characters in converted JSON string values')
  .option('--timeout <ms>', `Request timeout in milliseconds for XML-converter calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('-d, --debug [nameAndValue...]', 'Inject debug key/value into converted JSON. Defaults: name=DEBUGCOMMS value=1')
  .option('-o, --output <path>', 'Output JSON file path, or output directory when input is a folder')
  .option('-v, --verbose', 'Verbose logging')
  .action(convertXmlCommand);

program
  .command('sessions')
  .description('List saved OCCS sessions')
  .action(sessionsCommand);

program
  .command('use')
  .description('Set the default OCCS session')
  .option('--session <name>', 'Saved session alias or key to make current')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup')
  .action(useSessionCommand);

program
  .command('condition-check')
  .description('Evaluate Assembly Template document conditions against input JSON')
  .requiredOption('-p, --package <file>', 'Assembly Template JSON file path')
  .requiredOption('-i, --input <file>', 'Input JSON file path')
  .option('--expect-doc <id>', 'Expected document $$Id/description; repeat or comma-separate values', collectCsvOption, [])
  .option('--expect-docs <ids>', 'Expected document $$Ids/descriptions; comma-separate values', collectCsvOption, [])
  .option('--format <format>', 'Output format: pretty, md, json', 'pretty')
  .option('--show-check-summary', 'Include high-level check summary table in pretty output')
  .option('--show-near-misses', 'Show general near misses even when --expect-doc is provided')
  .option('--near-miss-threshold <value>', 'Near-miss minimum pass ratio (default 65%; accepts 0-1 or percent like 0.6 or 60)')
  .action(conditionCheckCommand);

program
  .command('template-compare')
  .description('Compare two Assembly Template JSON files semantically (documents/layouts/contents/iterations/fields)')
  .requiredOption('--a <file>', 'Assembly Template JSON file path A')
  .requiredOption('--b <file>', 'Assembly Template JSON file path B')
  .option('--format <format>', 'Output format: pretty, md, json', 'pretty')
  .action(templateCompareCommand);


  program
  .command('report-catalog')
  .description('Generate flat catalog of all CCS components')
  .option('-o, --output <dir>', 'Path to output folder', './output')  
  .action(catalogCommand);

program
  .command('report-xref')
  .description('Generate cross reference of all CCS components')
  .option('-o, --output <dir>', 'Path to output folder', './output')
  .action(crossrefCommand);

program
  .command('graph')
  .description('Generate a .DOT file for GraphViz')
  .option('-o, --output <dir>', 'Path to output folder', './output')
  .option('-d, --document <documentName>', 'Document to graph' )
  .option('-s,--styles', 'Include Styles in graph - WARNING: may produce a busy graph.')
  .option('-f,--fields', 'Include Fields in graph - WARNING: may produce a busy graph.')
  .option('--all-versions', 'Include all versions (default shows latest version per resource)')
  .action(graphCommand);

program
  .command('mockup [document]')
  .description('Generate an interactive document inspector from the latest versions in a refreshed local comms cache')
  .option('-c, --cache <dir>', 'Comms cache directory', './comms_cache')
  .option('-p, --package <name>', 'Package that contains the document (adds Assembly Template condition context)')
  .option('--all', 'Generate every cached document in the package')
  .option('-o, --output <file>', 'Output HTML file (or output directory with --all)')
  .action(mockupCommand);


program
  .command('login')
  .description('Log in to Oracle CCS and store session')
  .option('--env-file <path>', 'Path to .env file for login defaults')
  .option('-u, --username <username>', 'Username')
  .option('-p, --password <password>', 'Password')
  .option('-c, --customer <customer>', 'Customer short name')
  .option('-r, --region <region>', 'Oracle region')
  .option('--environment <environment>', 'Oracle environment (alias for region)')
  .option('-t, --tenancy <tenancy>', 'Tenancy path')
  .option('--session <name>', 'Saved session alias for this login')
  .action(loginCommand);


program
  .command('get-everything')
  .description('Get everything from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory for the complete CCS export cache')
  .option('--resume', 'Resume an interrupted export in --output, retrying incomplete or missing artifacts')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (cmd) => {
    if (cmd.resume && !cmd.output) throw new Error('`get-everything --resume` requires `--output <dir>` so the export cache is unambiguous.');
    const outputBase = cmd.output || './output';
    const exportResume = new ExportResumeState(outputBase, Boolean(cmd.resume));
    const commandFor = (type) => ({ ...cmd, output: path.join(outputBase, type), exportResume });
    const results = [
      await listPackagesCommand(commandFor('packages')),
      await listDocumentsCommand(commandFor('documents')),
      await listLayoutsCommand(commandFor('layouts')),
      await listContentsCommand(commandFor('contents')),
      await listFontsCommand(commandFor('fonts')),
      await listStylesCommand(commandFor('styles')),
      await listChartsCommand(commandFor('charts')),
    ];
    if (results.some((result) => result?.ok === false)) {
      console.error("⚠ Export completed with failures. Re-run `occs get-everything --resume --output <dir>` to retry incomplete or missing artifacts.");
      process.exitCode = 1;
      return;
    }
    console.log("(>'-')> ✨ Done!\n");
  });

const packageCommand = program
  .command('package')
  .description('Maintain communication packages')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup');

packageCommand
  .command('list [name]')
  .description('List communication packages')
  .option('--name <name>', 'Package short-name search text')
  .option('--timeout <ms>', `Request timeout in milliseconds for package API calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(packageListCommand);

packageCommand
  .command('get <name> [version]')
  .description('Download a package maintenance bundle')
  .option('--package-version <version>', 'Package version short name, or latest')
  .option('-o, --output <dir>', 'Output bundle directory')
  .option('--force', 'Overwrite bundle files in an existing output directory')
  .option('--timeout <ms>', `Request timeout in milliseconds for package API calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(packageGetCommand);

packageCommand
  .command('save <bundleDir>')
  .description('Save a package maintenance bundle to an open ConfigId')
  .requiredOption('--config-id <nameOrId>', 'Open ConfigId name, short name, or internal id')
  .option('--dry-run', 'Report changes without uploading')
  .option('--timeout <ms>', `Request timeout in milliseconds for package API calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(packageSaveCommand);

program
  .command('list-packages')
  .description('List communication packages from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump package data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listPackagesCommand);

for (const [name, description, action] of [
  ['get-package', 'Download one communication package and all active versions', getPackageCommand],
  ['get-document', 'Download one communication document and all active versions', getDocumentCommand],
  ['get-layout', 'Download one communication layout and all active versions', getLayoutCommand],
  ['get-content', 'Download one communication content item and all active versions', getContentCommand],
  ['get-font', 'Download one communication font', getFontCommand],
  ['get-style', 'Download one communication style', getStyleCommand],
  ['get-chart', 'Download one chart artifact and all active versions', getChartCommand],
]) {
  program
    .command(`${name} <shortName>`)
    .description(description)
    .option('-o, --output <dir>', 'Output directory')
    .option('-v, --verbose', 'Verbose logging')
    .action(action);
}

program
  .command('list-fonts')
  .description('List fonts from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump package data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listFontsCommand);


program
  .command('list-styles')
  .description('List communication styles from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump style data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listStylesCommand);

program
  .command('list-charts')
  .description('List chart artifacts from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump chart data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listChartsCommand);

program
  .command('list-documents')
  .description('List documents from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump document data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listDocumentsCommand);

const documentsCommand = program
  .command('documents')
  .description('Search and cache communication document metadata')
  .option('--session <name>', 'Saved session alias or key to use')
  .option('--customer <customer>', 'Customer short name for saved-session lookup')
  .option('--region <region>', 'Oracle region for saved-session lookup')
  .option('--environment <environment>', 'Oracle environment for saved-session lookup (alias for region)')
  .option('--tenancy <tenancy>', 'Tenancy path for saved-session lookup');

documentsCommand
  .command('catalog')
  .description('Search communication documents and write a JSON catalog')
  .option('--name <name>', 'Document short-name search text')
  .option('--query <query>', 'Alias for --name')
  .option('-o, --output <file>', 'Write catalog JSON to a file')
  .option('--timeout <ms>', `Request timeout in milliseconds for document API calls (default ${DEFAULT_REQUEST_TIMEOUT_MS})`)
  .option('--limit <n>', 'Page size for document API calls (default 49)')
  .option('--json', 'Write machine-readable JSON to stdout')
  .option('-v, --verbose', 'Verbose logging')
  .action(documentCatalogCommand);

program
  .command('list-layouts')
  .description('List layouts from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump layout data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listLayoutsCommand);

  program
  .command('list-contents')
  .description('List contents from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump content data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listContentsCommand);

if (!process.argv.includes('--json')) {
  showBanner();
}
program.allowUnknownOption(true);
for (const command of program.commands) {
  command.allowUnknownOption(true);
}
program.parse();
