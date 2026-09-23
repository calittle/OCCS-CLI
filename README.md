# OCCS CLI

> ## UNSUPPORTED — NOT AN ORACLE PRODUCT
>
> This is an independent open-source utility. It is not an Oracle product and
> is not supported, endorsed, maintained, or warranted by Oracle. Use it at
> your own risk; obtain support for Oracle products through Oracle's official
> support channels.

Licensed under the [GNU General Public License, version 3](LICENSE).


Oracle CCS CLI utility to interact with and analyze components from Oracle's Communication Cloud Service (CCS). This tool allows you to retrieve, catalog, cross-reference, and visualize element relationships using GraphViz-compatible `.dot` and `.svg` output.

## Prerequisites
This CLI tool requires:
* Node.js (v18+ recommended)
* npm (bundled with Node.js)
* Graphviz (dot command) – required to generate .svg graphs
* Poppler (`pdftoppm` and `pdfinfo`) – required for PDF smoke-test thumbnails and page counts
* ImageMagick (`identify` and `compare`) – required only for visual comparison in two-tenancy smoke tests
* Chrome or Chromium – required only for HTML visual comparison in two-tenancy smoke tests

### macOs
Use brew to install prerequisites.
`brew install node graphviz poppler imagemagick`

### Ubuntu
`sudo apt update && sudo apt install nodejs npm graphviz poppler-utils imagemagick`

### Windows
1. Download the [NodeJS Installer](https://nodejs.org) and run it.
1.	Download the [Installer](https://graphviz.org/download)
2. 	Run the Installer and use default options, ensure Graphviz is added to the system path. 
3. Install Poppler and ImageMagick, and add the folders containing their executables to the system `PATH`.
4.	Verify Installation by running at the command prompt: `dot -V`, `pdftoppm -v`, `pdfinfo -v`, and (for two-tenancy visual comparisons) `identify -version` and `compare -version`.

`npm install` installs JavaScript dependencies only. It does not install Graphviz, Poppler, ImageMagick, Chrome, or Chromium, because they are operating-system tools.


## Installation

1. Obtain the distribution from [git](https://github.com/calittle/OCCS-CLI.git) or from a ZIP file.
2. Unzip the package to a directory, e.g. `occs-cli` in your home directory.
3. Open a terminal in the install directory
4. Run the following:

```
npm install
npm link
```

## Usage

OCCS CLI 0.1.0

Usage: occs [options] [command] [parameters]

### Quick Start
```
occs login
occs get-everthing
occs report-catalog
occs report-xref
occs graph
```

### Options
1. `-V, --version`             output the version number
1. `-h, --help`                display help for command
1. `--notify`                  show a desktop notification and play a sound after successful command execution
1. `--pretty`                  pretty-print JSON output and preserve JSON string whitespace
1. `--timeout <ms>`            default HTTP request timeout for all OCCS calls (default `360000`, or 360 seconds)

### Commands
1. `report-catalog [options]`  Generate flat catalog of all CCS components
1. `report-xref [options]`     Generate cross reference of all CCS components
1. `graph [options]`           Generate a .DOT file for GraphViz
1. `login [options]`           Log in to Oracle CCS and store session
1. `sessions`                  List saved OCCS sessions
1. `use [options]`             Set the default OCCS session
1. `preview [options]`         Render a package preview file from input JSON/XML
1. `smoke [options]`           Run package preview smoke suite and draft an email report
1. `convertxml [options]`      Convert XML input files to JSON
1. `condition-check [options]` Evaluate Assembly Template document conditions against input JSON
1. `template-compare [options]` Compare two Assembly Template JSON files semantically
1. `preflight [options]`       Scan open ConfigIDs for in-flight records
1. `create-config [options] [shortName]` Create an open ConfigId
1. `close-config [options] [configId]` Mark a ConfigId as Closed
1. `migrate [options] [configId]` Initiate ConfigId movement between environments
1. `get-everything [options]`  Get everything from Oracle CCS
1. `package <command>`         List, get, and save package maintenance bundles
1. `list-packages [options]`   List communication packages from Oracle CCS
1. `list-fonts [options]`      List fonts from Oracle CCS
1. `list-styles [options]`     List communication styles from Oracle CCS
1. `list-charts [options]`     List chart artifacts from Oracle CCS
1. `list-documents [options]`  List documents from Oracle CCS
1. `list-layouts [options]`    List layouts from Oracle CCS
1. `list-contents [options]`   List contents from Oracle CCS
1. `help [command]`            display help for command

General parameters applicable to most commands:
1. `-o, --output` Specify the output directory where output is written. Default is `output`.
1. `-v, --verbose` Chatty logging. Default is `off`.

#### login
Log in to Oracle CCS and store the session.

`occs-cli login -u USERNAME -p PASSWORD --customer CUSTOMER --region REGION --tenancy TENANCY`

You can also run `occs login` with no flags and enter required values interactively.
Each successful login saves a session keyed by `customer.region/tenancy` and makes it current. Use `--session <name>` to add an alias.
Login credentials are saved encrypted for commands that must refresh Oracle tokens, such as XML conversion and XML preview. The session file stores only encrypted password material; the local encryption key is created at `~/.occs-cli/credential-key`.

`login` can read defaults from a local `.env` file and skip prompts for values found there:
* `OCCS_USERNAME`
* `OCCS_CUSTOMER` (customer short name)
* `OCCS_ENVIRONMENT` (region/environment)
* `OCCS_TENANCY`
* `OCCS_PASSWORD` (plain text)
* `OCCS_PASSWORD_ENC` (encrypted password)
* `OCCS_PASSWORD_KEY` (decryption key for `OCCS_PASSWORD_ENC`)
* `OCCS_EMAIL_CONFIG_UUID` (default email communication configuration UUID for `preview -r EMAIL`)
* `OCCS_EMAIL_RECIPIENTS` (comma-separated default recipient override for `preview -r EMAIL`)

`--environment` is also supported as an alias for `--region`.
`--env-file` is supported to explicitly set which env file to use.

Env file lookup order for `occs login`:
* `--env-file <path>` (if provided)
* `OCCS_ENV_FILE` (if set)
* `~/.occs.env`
* `~/.occs-cli/.env`
* `./.env` (current working directory)

Later files override earlier ones; shell environment variables override all file values.

If `login` reads `OCCS_PASSWORD` or `CCS_PASSWORD` from an env file, a successful login automatically replaces that plaintext entry with `OCCS_PASSWORD_ENC`/`OCCS_PASSWORD_KEY` or `CCS_PASSWORD_ENC`/`CCS_PASSWORD_KEY`.
Encrypted env password values use format `v1:<ivBase64>:<tagBase64>:<ciphertextBase64>`.

Unsure what to use? Look at the URL used to access CCS:
`https://[customer].[region].oraclecloud.com/[tenancy]/ui/Configuration/index.html`

#### sessions

List saved OCCS sessions and show which one is current.

`occs sessions`

#### use

Set the default/current session without logging in again.

Examples:
* `occs use --session pp`
* `occs use --tenancy pre-prod`
* `occs use --customer examplecustomer --environment example-region --tenancy non-prod`

The current session is used by commands when no explicit `--session` or target selector is provided.

Artifact downloads automatically retry transient CCS server responses (`5xx`, including `502`) up to three times, with 1- and 2-second backoff delays. Requests that still fail, and non-retryable responses such as `404`, are retained in the command's grouped failure report at the end of the run.

#### get-everything
Downloads all CCS data including packages, documents, layouts, contents, styles, fonts, and chart artifacts.

`occs-cli get-everything`

`get-everything` resumes its cache by default. To use a named cache directory:

`occs-cli get-everything --output ./comms_cache`

The command always refreshes the CCS collection indexes, then uses `get-everything-state.json` in that output directory to skip only fully completed, byte-verified artifacts with an unchanged source record. Missing, changed, corrupt, pending, and failed artifacts are downloaded again. The default cache directory is `./output`; use `--fresh` when a full re-download is required. `--resume` remains accepted for scripts but is now the default behavior.

The export is also recoverable if a font file cannot be retrieved: all metadata and every successfully downloaded file remain in place, styles are still exported, and a later `occs list-fonts` retries only missing font files. A failed font file is reported at the end and causes a non-zero exit code so unattended jobs can still detect the incomplete export.

#### list-charts

Downloads chart master records, versions, and their expanded series, categories, axes, and annotations. Each expanded artifact retains its CCS communication-style association records, whose referenced style JSON is downloaded by `list-styles` (and therefore `get-everything`).

`occs list-charts --output ./output/charts`

#### Targeted artifact downloads

Download one exact artifact by CCS short name without exporting every artifact of
that type.  Package, document, content, and chart downloads retain every active
version returned by the corresponding CCS master resource.

* `occs get-package example_bills --output ./output/packages`
* `occs get-document CO-G1-CO1 --output ./output/documents`
* `occs get-layout Letter_Header --output ./output/layouts`
* `occs get-content Welcome_Text --output ./output/contents`
* `occs get-font CorporateSans --output ./output/fonts`
* `occs get-style Standard_Body --output ./output/styles`
* `occs get-chart Monthly_Sales --output ./output/charts`

The name must match an artifact short name exactly (case-insensitively). The CLI
uses a server-side short-name search to avoid downloading unrelated artifacts,
then rejects partial or ambiguous matches.

#### package

Maintain communication packages with a small ATool-friendly command surface.

Examples:
* `occs package list example_bills --json`
* `occs package get example_bills --package-version 16.0 --output ./work/example_bills-16.0 --json`
* `occs package get example_bills 16.0 --output ./work/example_bills-16.0 --json`
* `occs package save ./work/example_bills-16.0 --config-id 2026-06-05-1500 --json`
* `occs package save ./work/example_bills-16.0 --config-id 2026-06-05-1500 --dry-run --json`

`package get` writes a maintenance bundle:

```
example_bills-16.0/
  occs-package.json
  assembly-template.json
  version-master.json
  document-associations.json
```

`assembly-template.json` contains the Assembly Template JSON blob. `version-master.json` contains the version master fields needed for package maintenance, including document ordering via `DocumentRelIndex`. `occs-package.json` is the manifest ATool should use to identify the package/version UUIDs, file paths, source hashes, and API endpoints.
`document-associations.json` is a resolved helper file for UIs. It maps each package/document relationship row to document config metadata such as `documentShortName`, `documentConfigUuid`, `documentRelIndex`, and `documentAlwaysTriggerInd`. The authoritative save surface remains `version-master.json`.

`package save` requires `--config-id`, resolves it to the internal open ConfigId, and uses it only on save requests. The command does not create package versions and does not expose ConfigId list/create operations.

When a bundle has changes, `package save` reports which bundle files changed. Assembly Template-only changes upload only the Assembly Template blob. Version master changes also re-upload the current Assembly Template blob so package document metadata and the template blob remain paired in Comms. `--dry-run --json` reports changed files and the upload plan without uploading either request.

By default, JSON written by the CLI is flattened: formatting whitespace is omitted and `\n`, `\r`, and `\t` are removed from JSON string values and object keys before writing or submitting Comms-facing JSON. Use `--pretty` to preserve the previous indented JSON output.

When `--json` is passed, stdout contains only one JSON object. Progress and verbose logs are written to stderr, and failures return a non-zero exit code with an `{ "ok": false, "error": ... }` JSON payload.

### Document Catalog

Use the document catalog command to build or refresh a searchable document metadata cache for tools such as ATool:

* `occs documents catalog --json`
* `occs documents catalog --name CO-G3 --json`
* `occs documents catalog --name demo -o ~/.atool/document-catalog.json --json`

The JSON output includes document config UUID, short name, name, description, and ConfigId. ATool can use this cache to add package document associations by short name while saving the underlying `CommunicationDocumentConfigUuid`.

#### preflight

Scans open ConfigIDs and flags which ones have in-flight records based on the same configuration-detail flow used in `LoginApp_Package`.

`occs-cli preflight`

To scan only one ConfigID:

`occs-cli preflight --config-id <CONFIG_ID>`

Artifacts are written to the `preflight` subdirectory of the output directory, including a `summary.json` plus one JSON file per scanned ConfigID.

#### create-config

Creates a new open ConfigId using the same `ConfigurationRec` flow as the Comms UI.

`occs create-config 2026-06-10-1300 --session non-prod --desc "Config closing 10 JUN 2026 1pm EDT"`

The positional value becomes `ConfigurationInfo.ShortName`. `--name` defaults to the same value, and `--desc` defaults to blank. The command prints the internal `ConfigurationId` returned by CCS; use that value with commands that save changes into a config.

Use `--dry-run` to build the create payload without sending it:

`occs create-config 2026-06-10-1300 --session non-prod --dry-run`

In the Comms UI, choosing a newly created ConfigId as active causes later edit requests to send that internal ID as the `transactionconfigid` header. OCCS CLI commands that write into a config use explicit `--config-id` options for the same purpose.

#### close-config

Marks a source-environment ConfigId as Closed using the same `ConfigurationRec` flow as the Comms UI.

`occs close-config build-01 --session non-prod`

The ConfigId can be a ShortName, Name, internal `ConfigurationId`, or `ConfigurationUuid`. By default the command only closes ConfigIds currently in `Open` state; use `--force` to submit the close request for another non-`CloseInProgress` status.

Use `--dry-run` to resolve the ConfigId without changing it:

`occs close-config build-01 --session non-prod --dry-run`

#### migrate

Initiates ConfigId movement from a source environment to a target environment. The command refreshes a source access token from saved source credentials when available, asks the target environment for the eligible movement list, and then calls the target movement endpoint.

`occs migrate --source-session non-prod --target-tenancy pre-prod`

The target session defaults to the current OCCS session, so this is also valid after `occs use --session pre-prod`:

`occs migrate --source-session non-prod`

The Comms initiate endpoint does not send a selected ConfigId; it starts movement for every eligible closed ConfigId returned by the target for the source token. If you pass `migrate <configId>` or `--config-id`, OCCS CLI only uses that value as a sanity check that the ConfigId appears in the eligible list before initiating movement for the full eligible set.

Use `--dry-run` to fetch and validate the eligible list without initiating movement:

`occs migrate --source-session non-prod --target-tenancy pre-prod --dry-run`

#### convertxml

Convert XML input to JSON without rendering a preview. By default this uses Oracle CCS; pass `--xsd` to convert locally from a schema instead.

`occs convertxml --input ./data/input.xml --output ./data/input.json`

If `--input` points to a folder, `convertxml` recursively finds all `.xml` files and writes matching `.json` files under the output directory, preserving the input folder structure.

For XML batches with multiple `<C1-BillPrintRecord>` or `<billPrint>` elements, `convertxml` converts each transaction and suffixes output filenames by `billId` when available.

Before contacting Oracle, OCCS CLI checks that each XML input is well-formed and reports the local parser error (including its line and column when available).

By default, converted JSON is rerooted to `billPrint`, matching XML preview behavior. Oracle conversion requires credentials from encrypted saved login credentials, env, or flags (`OCCS_USERNAME` and password via `OCCS_PASSWORD` or `OCCS_PASSWORD_ENC` + `OCCS_PASSWORD_KEY`). Local `--xsd` conversion does not require Oracle credentials.

Optional parameters:
* `--session <name>`: Use a saved session alias or full session key (`customer.region/tenancy`) instead of the current session.
* `--customer <customer>`, `--region <region>`/`--environment <environment>`, `--tenancy <tenancy>`: Select a saved session by target. Omitted target parts default from the current session.
* `--timeout <ms>`: Request timeout override for XML-converter calls. Default is `360000` (360 seconds).
* `-d, --debug [name] [value]`: Inject a debug key/value into converted JSON. Defaults to `DEBUGCOMMS=1` when `-d` is provided without values.
* `-o, --output <path>`: Output JSON file path for a single input file, or output directory for folder input. Folder input mirrors the input folder structure.
* `--env-file <path>`: Optional env file path for credential defaults.
* `--extract <expr>`: For batch XML input, extract a single record by expression from each XML file (supports `field=value` or `field==value`), e.g. `billId=002051606115`.
* `--xsd <path>`: Use a local XSD for conversion instead of `XmlToJsonConverter`. Relative `xs:include` and `xs:import` references are resolved from the containing XSD. Elements declared with `maxOccurs` greater than one (or `unbounded`) are emitted as JSON arrays. XSD numeric and boolean types become JSON primitives; schema strings retain identifiers and leading zeroes. Empty optional XML elements are omitted, matching the Oracle converter.
* `--reroot <newRoot>`: Reroot converted JSON to the specified element. By default, the converter automatically chooses `billPrint` or `statementPrint` from the XML document.
* `--disable-reroot`: Disable converted JSON rerooting entirely (overrides the default `billPrint` reroot).
* `--preserveNL`: Preserve newline characters in converted JSON string values before final JSON serialization. Final output is still flattened unless `--pretty` is also passed.

Examples:
* `occs convertxml -i ./data/input.xml -o ./json/input.json --session pre-prod`
* `occs convertxml -i ./xml-batch-dir -o ./json-output --tenancy non-prod`
* `occs convertxml -i ./data/input.xml --disable-reroot`
* `occs convertxml -i ./data/input.xml -o ./data/input.json --xsd ./schemas/bill-print.xsd`

#### preview

Render a package preview, or submit an email communication, from input JSON or XML to CCS.

`occs preview --input ./data/input.json --package MY_PACKAGE`

If `--input` points to a folder, `preview` recursively finds all `.json` files and renders each one.

If the input is XML (`.xml` or file starts with `<`), `preview` will:
* Validate XML well-formedness locally before contacting Oracle
* Normalize selected XML transaction payload whitespace for converter submission
* Auto-detect multi-transaction batches (multiple `<C1-BillPrintRecord>` or `<billPrint>` elements), preview each transaction, and suffix output filenames by `billId` when available
* Call `CommunicationFileTransfer/v1/XmlToJsonConverter`, or convert locally when `--xsd` is supplied
* Reroot the converted JSON to `billPrint` by default before preview submission
* Re-login (converter invalidates token)
* Submit converted JSON to `CommunicationAssembly/v1/CommunicationAssemblyRec`

For XML preview, credentials must be available from encrypted saved login credentials, env, or flags (`OCCS_USERNAME` and password via `OCCS_PASSWORD` or `OCCS_PASSWORD_ENC` + `OCCS_PASSWORD_KEY`).

Optional parameters:
* `--session <name>`: Use a saved session alias or full session key (`customer.region/tenancy`) instead of the current session.
* `--customer <customer>`, `--region <region>`/`--environment <environment>`, `--tenancy <tenancy>`: Select a saved session by target. Omitted target parts default from the current session.
* `-e, --effective-date <date>`: Effective date in `YYYY-MM-DD` format. Defaults to today.
* `-r, --render-type <type...>`: One or more render types (`PDF`, `HTML`, `TEXT`, `CSV`, `JSON`, `METADATA`, `EMAIL`). Supports comma-separated (`-r PDF,HTML`) or space-separated (`-r PDF HTML`) values. Defaults to `PDF`.
* `--email-config-uuid <uuid>`: Required for `EMAIL` unless `OCCS_EMAIL_CONFIG_UUID` is set. This is the `CommunicationConfigUuid` used by the email communication API.
* `--recipient <email>`: Override `billPrint.billDetails.cmElements.eBill.recipientEmails`; repeat the option or use comma-separated values. The CLI creates the `eBill.recipientEmails` structure when absent. If omitted, `OCCS_EMAIL_RECIPIENTS` is used when set; otherwise, recipients from the input JSON are preserved.
* `--send-email`: Submit the real email. Without it, `EMAIL` validates the request and reports the recipients and configuration it would use, without posting to Comms.
* `--timeout <ms>`: Request timeout override for preview/XML-converter calls. Default is `360000` (360 seconds).
* `-d, --debug [name] [value]`: Inject a debug key/value into the input JSON (or converted XML JSON) before preview submission. Defaults to `DEBUGCOMMS=1` when `-d` is provided without values. Supports dot notation for nested keys (example: `--debug root.flags.DEBUGCOMMS 1`).
* `-o, --output <path>`: Output file path (or directory). Defaults to the current working directory using the input filename stem plus extension based on render type. When `--input` is a folder, `--output` must be a directory path and output filenames mirror the input folder structure.
* `--env-file <path>`: Optional env file path for credential defaults.
* `--extract <expr>`: For batch XML input, extract a single record by expression (supports `field=value` or `field==value`), e.g. `billId=002051606115`.
* `--xsd <path>`: For XML input, convert locally using this XSD instead of the Oracle XML conversion API. Preview still requires a valid saved access token or credentials to submit the rendered request.
* `--reroot <newRoot>`: For XML input, reroot converted JSON to the specified element before preview submission. By default, the converter automatically chooses `billPrint` or `statementPrint` from the XML document.
* `--disable-reroot`: For XML input, disable converted JSON rerooting entirely (overrides the default `billPrint` reroot).

Examples:
* `occs login -c examplecustomer -r example-region -t non-prod --session non-prod`
* `occs login -c examplecustomer -r example-region -t pre-prod --session pre-prod`
* `occs preview -i ./data/input.xml -p MY_PACKAGE --session pre-prod`
* `occs preview -i ./data/input.xml -p MY_PACKAGE --tenancy non-prod`
* `occs preview -i ./data/input.xml -p MY_PACKAGE --xsd ./schemas/bill-print.xsd`
* `occs preview -i ./data/input.json -p MY_PACKAGE -d` -> injects `DEBUGCOMMS: 1`
* `occs preview -i ./data/input.json -p MY_PACKAGE -d DEBUGCOMMS 0`
* `occs preview -i ./data/input.json -p MY_PACKAGE -d root.flags.DEBUG "on"`
* `occs preview -i ./data/input.json -r EMAIL --email-config-uuid "$OCCS_EMAIL_CONFIG_UUID" --recipient andy.little@oracle.com --send-email`

Preview writes the rendered output file (for example `.pdf`) decoded from `CommunicationAssemblyInfo.AssemblyRenderOutput`.
When `-v/--verbose` is enabled and the API returns JSON wrapper output, preview also writes:
* Response wrapper JSON sidecar: `<output-name>.response.json`

If a preview request fails and Oracle returns an error body, preview writes an error sidecar:
* JSON errors: `<output-name>.response.error.<status>.json`
* Non-JSON errors: `<output-name>.response.error.<status>.txt`

For XML input, preview also writes the converted JSON used as `AssemblyData`:
* Generated input JSON sidecar: `<output-name>.generated-input.json`

Preview submits flattened `AssemblyData` JSON by default. Use `--pretty` to submit and write indented JSON instead.

`EMAIL` posts `CommunicationInfo` to `Communication/v1/CommunicationRec` with the input JSON serialized into `CommunicationData`. It does not create a rendered output file. `--package` is not required for an `EMAIL`-only request.

#### smoke

Run a small set of package previews and create an **unsent** email draft. A normal smoke run only verifies that each requested PDF or HTML output is generated and it never sends email.

Create a suite JSON file. Input paths are relative to the suite file, so the suite and its sample-input folder can be moved together:

```json
{
  "name": "Example pre-production smoke",
  "tenancy": "pre-prod",
  "tests": [
    { "id": "bill-rt", "type": "Bill RT", "package": "example_bills", "input": "bill-RT.json" },
    { "id": "bill-nrt", "type": "Bill NRT", "package": "example_bills", "input": "bill-NRT.json" },
    { "id": "bill-bulk", "type": "Bill BULK", "package": "example_bills", "input": "bill-BULK.json" },
    { "id": "bill-plt", "type": "Bill PLT", "package": "example_bills", "input": "bill-PLT.json" },
    { "id": "letter", "type": "Letter", "package": "example_letters", "input": "letter.json" },
    { "id": "ebill", "type": "eBill", "package": "example_email_body_ebill", "input": "eBill.json", "output": "html" }
  ]
}
```

Run it with:

```sh
occs smoke --suite ./smoke-suite.json --output ./smoke-output
```

Each entry renders PDF by default. Set `"output": "html"` on a test to request HTML instead. The existing `"renderTypes": ["PDF", "HTML"]` form remains available when a test must generate both. Use `--tenancy non-prod` to override the suite target. Every new run writes to a date/time-stamped output folder (for example, `smoke-output-2026-08-25_14-30-15-123`) so earlier results are retained. Add `--resume` to reuse the most recent matching output folder: successful non-empty outputs are retained, while missing or failed previews are retried. In comparison mode, this applies independently to each environment. PDF tests are compared by rendered PDF pages; HTML-only tests are captured in a fixed Chrome/Chromium viewport and compared as full-page PNGs. A single-environment HTML-only test also uses that capture as its report thumbnail. HTML comparison requires Chrome or Chromium; set `OCCS_SMOKE_BROWSER` if it is not in a standard location. The run writes `smoke-results.json`, rendered files under `previews/`, PDF and HTML PNG thumbnails under `thumbnails/`, a browser report (`smoke-report.html`), and two email draft artifacts: `smoke-email.html` and `smoke-email.eml`. The report and email identify each test's input file, and list the page count for every generated PDF. They begin with the environment, generation counts, and—when comparing environments—visual-comparison pass, review, and failure counts. Open the `.eml` file in Outlook to review or edit the message, then send it yourself if appropriate.

To compare two targets side by side, add a second target:

```sh
occs smoke --suite ./smoke-suite.json --tenancy non-prod --compare-tenancy pre-prod
```

Both environments must generate a PDF for the comparison to run. The report shows a thumbnail for each target, a separate render result for each, and a comparison result: **Pass**, **Review**, or **N/A**. It rasterizes every PDF page and ignores small anti-aliasing differences (3% pixel fuzz). A comparison passes when the most different page has no more than 1% changed pixels; change that tolerance with `--compare-threshold 0.02`. Review cases retain a visual difference image under `comparisons/`.

To run both the regular smoke test and the Non-Prod-to-Pre-Prod comparison from this checkout on macOS, use:

```zsh
./run-smoke-tests.zsh
```

Pass `--resume` to retry only failed or missing outputs in the most recent runs:

```zsh
./run-smoke-tests.zsh --resume
```

The script defaults to the configured samples folder. Override it with `OCCS_SAMPLES_DIR=/path/to/samples` when the suite has moved.

On Windows, use the equivalent batch file from Command Prompt:

```bat
run-smoke-tests.bat
```

Pass `--resume` in the same way, and set `OCCS_SAMPLES_DIR` or `OCCS_SMOKE_SUITE` before running if the samples or suite file have moved:

```bat
set "OCCS_SAMPLES_DIR=C:\path\to\samples"
run-smoke-tests.bat --resume
```

For statement samples, use the runner that matches the check you want:

| Check | macOS | Windows | Default target(s) |
| --- | --- | --- | --- |
| Single-environment statement smoke test | `./run-smoke-stmt.zsh` | `run-smoke-stmt.bat` | `non-prod` (`OCCS_SMOKE_TARGET` overrides it) |
| Statement comparison | `./run-smoke-compare-stmt.zsh` | `run-smoke-compare-stmt.bat` | `non-prod` → `pre-prod` (`OCCS_COMPARE_SOURCE` / `OCCS_COMPARE_TARGET` override them) |

All four statement runners forward options such as `--resume` to `occs smoke`.

#### condition-check

Deterministically evaluate `Documents[*].Condition` in an Assembly Template JSON against an input JSON payload.

`occs condition-check --package ./AssemblyTemplate.json --input ./sample-input.json`

`--package/-p` also accepts a bare name and resolves it as `./<name>.json` (for example `-p AssemblyTemplate` -> `./AssemblyTemplate.json`).

Optional:
* `--format pretty|md|json` (default `pretty`)
* `--expect-doc <id>` / `--expect-docs <ids>` to require/report expected document triggers. Repeat it or use comma-separated IDs.
* `--show-check-summary` to include the high-level check summary table in `pretty` output
* `--show-near-misses` to include general near misses when `--expect-doc` is provided
* `--near-miss-threshold <value>` to tune near-miss fuzziness (default `65`, accepts 0-1 or percent, e.g. `0.6` or `60`)

Condition evaluation is Comms-compatible for filtered `empty true` checks: if a filtered collection parent is missing, for example `billChars[?(...)]`, the check fails unless the condition explicitly guards the collection with a null/empty branch or the input emits an empty array.

Example:
* `occs condition-check -p ./example_bills.json -i ./66135.json --expect-doc EXAMPLE-DOC-23`

Output includes:
* Triggered `Documents[*].$$Id`
* Expected document reports showing why requested docs did or did not trigger
* Triggered `Layouts[*].Contents[*]` items that have `Condition` (within triggered documents)
* Passing condition fragments for triggered docs
* Near-miss evidence (partially satisfied candidates) in `pretty` format
* Full non-triggered conditioned content evidence (no near-miss threshold applied for content)
* Closest-match analysis with failed checks when no docs trigger

#### template-compare

Compare two Assembly Template JSON files using CCS-aware structure (not just line-by-line text diff).

`occs template-compare --a ./AssemblyTemplate_A.json --b ./AssemblyTemplate_B.json`

Optional:
* `--format pretty|md|json` (default `pretty`)

Output includes:
* Document IDs in A but not in B, and vice versa
* Document `Condition` changes
* Document metadata changes when present (for example `Updated`, `Desc`, `Comments`, custom keys)
* Layout additions/removals per document (including nested layout paths)
* Content additions/removals and `Condition` changes per layout
* Iteration changes for content blocks (`Iteration.$$Id`, `Type`, `Path`, and iterator field mapping diffs)
* Top-level `Fields` changes:
  * Field names in A but not in B, and vice versa
  * Mapping changes (`Path`, `Mandatory`, `Desc`) for shared field names
  * Field metadata changes when present (for example `Updated`, `Description`, `XPath`, custom keys)

#### list-[objectType]

Download raw metadata for the object type (e.g. packages, documents, contents, styles, fonts)

`occs-cli list-[objectType]` where `objectType` is one of:
* documents
* layouts
* contents
* styles
* fonts

####  report-catalog

Generates flat catalogs of all CCS components for quick overview. Separate CSV files are generated for each object type in the "catalog" subdirectory of the output directory.

`occs-cli report-catalog`

#### report-xref

Generate a cross-reference CSV of relationships across documents, layouts, contents, styles, fonts, and fields. The file is output in the "crossref" subdirectory of the output directory.

Content blobs are scanned for embedded references, including field usage in `<comms-data>` / `<comms-cond>` tags and conditional content references such as `$Cond{"Condition":"DC472=='xyz'","Content":"Some_Content_Item"}`. Conditional content references are reported as `Content` → `Content` rows with `usageType=cond-content`.

`occs-cli report-xref`

#### graph

Generate .dot and .svg graphs for document-object relationships. Output is written into the "graphs" subdirectory of the output directory and are named for the document(s).

To generate a graph for a specific document, use the `-d,--document` option with the name of the document, e.g.:

`occs-cli graph -d CO-G1-CO1`

Issue the command without the `-d,--document` option to generate graphs for all documents.

`occs-cli graph`

##### Options
Options can be combined.
* `-s,--styles`: Include styles (Note this may clutter the graph), e.g. `occs-cli graph -d CO-G1-CO1 -s`
* `-f,--fields`: Include fields (Note this may clutter the graph), e.g. `occs-cli graph -d CO-G1-CO1 -f`
* `--all-versions`: Include all resource versions in graph output (default is latest version per resource)

#### mockup

Generate a standalone interactive document inspector from a cache refreshed with `get-everything`. The generator always resolves the highest cached semantic version of the document and every reachable content blob. The complete inspector data model is embedded in the HTML, so the output is portable as a single file.

`occs mockup EXAMPLE-DOC-1 --cache ./comms_cache --package example_bills --output ./output/EXAMPLE-DOC-1-inspector.html`

Use `--package` when the document belongs to a package so the inspector can include the Assembly Template's document condition.

Generate every cached document referenced by the latest package Assembly Template:

`occs mockup --package example_bills --all --cache ./comms_cache`

With `--all`, output defaults to `./comms_cache/mockups/example_bills/`. If supplied, `--output` is an output directory rather than an HTML filename.

#### Refresh cache and generate selected mockups

The `examples/refresh-and-mockups.zsh` (macOS/Linux) and
`examples/refresh-and-mockups.ps1` (Windows) scripts refresh their configured
cache directly, preserving `get-everything`'s resume manifest, and generate
mockups. Both default to `CLP_bills`, `CLP_letters`, `CLP_braille`,
`CLP_Emails`, and `CLP_statements`.

Run the Zsh version from the directory where you want `comms-cache/` and
`mockups/` created:

```zsh
zsh examples/refresh-and-mockups.zsh
zsh examples/refresh-and-mockups.zsh -c /path/to/comms-cache -m /path/to/mockups -p CLP_bills -p CLP_letters
```

Run the PowerShell version similarly:

```powershell
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File .\examples\refresh-and-mockups.ps1
PowerShell.exe -NoProfile -ExecutionPolicy Bypass -File .\examples\refresh-and-mockups.ps1 -Cache C:\work\comms-cache -Mockups C:\work\mockups -Package CLP_bills,CLP_letters
```

The PowerShell script runs in the Windows PowerShell included with Windows. For
a locked-down VDI, it does not require installation or administrator permissions
beyond having `occs` on `PATH`. Pass `-Occs C:\tools\occs.cmd` if it is elsewhere.
To copy a completed export into the cache without downloading again, pass
`-Source C:\path\to\output`; that path uses the built-in `robocopy.exe` utility.


# File Structure
```
output/
  +- packages/
  |      +- <package>/
  |            + <package>_master.json (Package master record from CCS)
  |            +- versions/ 
  |                  +- <package_version>/
  |                       + <package_version>.json (Package version record from CCS)
  |                       + AssemblyTemplate.json (Assembly Template from CCS)
  +- documents/
  |      +- <document>/
  |            + <document>_master.json (Document master record from CCS)
  |            +- versions/ 
  |                  + <document_version>.json (Document version record from CCS)
  +- layouts/
  |      +- <layout>/
  |            + <layouy>.json (Layout record from CCS)
  +- contents/
  |      +- <content>/
  |            + <content>_master.json (Content master record from CCS)
  |            +- versions/ 
  |                  + <content_version>.json (Content version record from CCS)
  |                  + <uuid>.blob (HTML Content from CCS)
  +- styles/
  |      +- <style>/
  |            + <style>.json (Style record from CCS)
  +- fonts/
  |      +- <font name>/
  |              + <font>.ttf
  |              + <font name>.json (Font record from CCS)
  +- charts/
  |      +- <chart>/
  |            + chart.json (Chart list record from CCS)
  |            + <chart>_master.json (Chart master record from CCS)
  |            +- versions/
  |                  +- <version>/
  |                        + <version>.json (Expanded chart version, including style associations)
  |                        +- series/, categories/, category-axes/, series-axes/, annotations/
  +- catalog/
  |      + contents.csv (list of contents)
  |      + documents.csv (list of documents)
  |      + fields.csv (list of fields)
  |      + layouts.csv (list of layouts)
  |      + pacakage_docs.csv (list of packages/documents)
  |      + packages.csv (list of packages)
  |      + styles.csv (list of styles)
  +- graphs/
  |      + <document>.dot (intermediary file)
  |      + <document>.svg (graph file)
  +- crossref
         + crossref.csv
```
## Extending
Each command lives in `lib/` and can be extended independently:
*	lib/auth.js
*	lib/packages.js
*	lib/graph.js (GraphViz rendering)
*	lib/crossRef.js (xref report logic)
*	etc.
