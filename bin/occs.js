#!/usr/bin/env node
import { Command } from 'commander';
import loginCommand from '../lib/auth.js';
import { listDocumentsCommand } from '../lib/documents.js';
import { listPackagesCommand } from '../lib/packages.js';
import { listLayoutsCommand } from '../lib/layouts.js';
import { listContentsCommand } from '../lib/contents.js';
import { listStylesCommand } from '../lib/styles.js';
import { listFontsCommand } from '../lib/fonts.js';
import { catalogCommand } from '../lib/catalog.js';
import { crossrefCommand } from '../lib/crossRef.js';
import { graphCommand } from '../lib/graph.js';
import { listCompaniesCommand } from '../lib/companies.js';
import { listConfigsCommand } from '../lib/configs.js';
import { preflightCommand } from '../lib/preflight.js';
import { previewCommand } from '../lib/preview.js';
import { conditionCheckCommand } from '../lib/conditionCheck.js';

const program = new Command();
function showBanner() {
  console.log('');
  console.log('OCCS CLI 1.0.0 🚀');
  console.log('');
}
program
  .name('occs')
  .description('Oracle CCS CLI utility')
  .version('1.0.0');

program
  .command('list-companies')
  .description('Generate list of companies')
  .option('-o, --output <dir>', 'Path to output folder')  
  .action(listCompaniesCommand);

program
  .command('list-configs')
  .description('Generate list of open configuration IDs')
  .option('-o, --output <dir>', 'Path to output folder')  
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
  .command('preview')
  .description('Render a communication package preview from input JSON or XML')
  .requiredOption('-i, --input <file>', 'Input JSON/XML file path')
  .requiredOption('-p, --package-name <name>', 'Communication package short name')
  .option('--env-file <path>', 'Path to .env file for credential defaults')
  .option('--extract <expr>', 'For XML batches, extract a single record by expression (e.g. billId==002051606115)')
  .option('--reroot <newRoot>', 'For XML input, reroot payload to this XML element, e.g. billPrint')
  .option('--timeout <ms>', 'Request timeout in milliseconds for preview/converter calls (default 30000)')
  .option('-e, --effective-date <date>', 'Effective date (YYYY-MM-DD), defaults to today')
  .option('-r, --render-type <type...>', 'Render type(s): PDF, HTML, CSV, JSON, METADATA (supports comma or space separated values)', ['PDF'])
  .option('-o, --output <path>', 'Output file path (or directory)')
  .option('--ding', 'Play terminal bell after successful preview output')
  .option('-v, --verbose', 'Verbose logging')
  .action(previewCommand);

program
  .command('condition-check')
  .description('Evaluate Assembly Template document conditions against input JSON')
  .requiredOption('--at <file>', 'Assembly Template JSON file path')
  .requiredOption('--input <file>', 'Input JSON file path')
  .option('--format <format>', 'Output format: pretty, md, json', 'pretty')
  .option('--show-check-summary', 'Include high-level check summary table in pretty output')
  .option('--near-miss-threshold <value>', 'Near-miss minimum pass ratio (default 65%; accepts 0-1 or percent like 0.6 or 60)')
  .action(conditionCheckCommand);


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
  .action(graphCommand);


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
  .action(loginCommand);


program
  .command('get-everything')
  .description('Get everything from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump package data')
  .option('-v, --verbose', 'Verbose logging')
  .action(async (cmd) => {
    await listPackagesCommand(cmd);
    await listDocumentsCommand(cmd);    
    await listLayoutsCommand(cmd);
    await listContentsCommand(cmd);
    await listFontsCommand(cmd);
    await listStylesCommand(cmd);
    console.log("(>'-')> ✨ Done!\n");
  });

program
  .command('list-packages')
  .description('List communication packages from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump package data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listPackagesCommand);

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
  .command('list-documents')
  .description('List documents from Oracle CCS')
  .option('-o, --output <dir>', 'Output directory to dump document data')
  .option('-v, --verbose', 'Verbose logging')
  .action(listDocumentsCommand);

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

showBanner();
program.parse();
