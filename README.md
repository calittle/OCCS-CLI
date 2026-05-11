# OCCS CLI
* Version 0.1.0
* Release Date 1 October 2025
* Author andy.little@oracle.com


Oracle CCS CLI utility to interact with and analyze components from Oracle's Communication Cloud Service (CCS). This tool allows you to retrieve, catalog, cross-reference, and visualize element relationships using GraphViz-compatible `.dot` and `.svg` output.

## Prerequisites
This CLI tool requires:
* Node.js (v18+ recommended)
* npm (bundled with Node.js)
* Graphviz (dot command) – required to generate .svg graphs

### macOs
Use brew to install prerequisites.
`brew install node graphviz`

### Ubuntu
`sudo apt update && sudo apt install nodejs npm graphviz`

### Windows
1. Download the [NodeJS Installer](https://nodejs.org) and run it.
1.	Download the [Installer](https://graphviz.org/download)
2. 	Run the Installer and use default options, ensure Graphviz is added to the system path. 
3.	Verify Installation by running at the command prompt: `dot -V`


## Installation

```
git clone https://github.com/calittle/OCCS-CLI.git
cd occs-cli
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

### Commands
1. `report-catalog [options]`  Generate flat catalog of all CCS components
1. `report-xref [options]`     Generate cross reference of all CCS components
1. `graph [options]`           Generate a .DOT file for GraphViz
1. `login [options]`           Log in to Oracle CCS and store session
1. `preview [options]`         Render a package preview file from input JSON
1. `preflight [options]`       Scan open ConfigIDs for in-flight records
1. `get-everything [options]`  Get everything from Oracle CCS
1. `list-packages [options]`   List communication packages from Oracle CCS
1. `list-fonts [options]`      List fonts from Oracle CCS
1. `list-styles [options]`     List communication styles from Oracle CCS
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

`login` can read defaults from a local `.env` file and skip prompts for values found there:
* `OCCS_USERNAME`
* `OCCS_CUSTOMER` (customer short name)
* `OCCS_ENVIRONMENT` (region/environment)
* `OCCS_TENANCY`
* `OCCS_PASSWORD` (plain text)
* `OCCS_PASSWORD_ENC` (encrypted password)
* `OCCS_PASSWORD_KEY` (decryption key for `OCCS_PASSWORD_ENC`)

`--environment` is also supported as an alias for `--region`.
`--env-file` is supported to explicitly set which env file to use.

Env file lookup order for `occs login`:
* `--env-file <path>` (if provided)
* `OCCS_ENV_FILE` (if set)
* `~/.occs.env`
* `~/.occs-cli/.env`
* `./.env` (current working directory)

Later files override earlier ones; shell environment variables override all file values.

For encrypted password values, use format `v1:<ivBase64>:<tagBase64>:<ciphertextBase64>`.
Generate one with Node:

`node -e "const crypto=require('crypto');const pwd=process.argv[1];const key=process.argv[2];const iv=crypto.randomBytes(12);const k=crypto.scryptSync(key,'occs-cli-password-salt',32);const c=crypto.createCipheriv('aes-256-gcm',k,iv);const enc=Buffer.concat([c.update(pwd,'utf8'),c.final()]);const tag=c.getAuthTag();console.log('v1:'+iv.toString('base64')+':'+tag.toString('base64')+':'+enc.toString('base64'));\" \"YOUR_PASSWORD\" \"YOUR_KEY\"`

Unsure what to use? Look at the URL used to access CCS:
`https://[customer].[region].oraclecloud.com/[tenancy]/ui/Configuration/index.html`

#### get-everything
Downloads all CCS data including packages, documents, layouts, contents, styles, and fonts.

`occs-cli get-everything`

#### preflight

Scans open ConfigIDs and flags which ones have in-flight records based on the same configuration-detail flow used in `LoginApp_Package`.

`occs-cli preflight`

To scan only one ConfigID:

`occs-cli preflight --config-id <CONFIG_ID>`

Artifacts are written to the `preflight` subdirectory of the output directory, including a `summary.json` plus one JSON file per scanned ConfigID.

#### preview

Render a package preview by submitting input JSON or XML to CCS.

`occs preview --input ./data/input.json --package-name MY_PACKAGE`

If the input is XML (`.xml` or file starts with `<`), `preview` will:
* Minify XML by removing inter-tag whitespace
* Call `CommunicationFileTransfer/v1/XmlToJsonConverter`
* Re-login (converter invalidates token)
* Submit converted JSON to `CommunicationAssembly/v1/CommunicationAssemblyRec`

For XML preview, credentials must be resolvable from env/flags (`OCCS_USERNAME` and password via `OCCS_PASSWORD` or `OCCS_PASSWORD_ENC` + `OCCS_PASSWORD_KEY`).

Optional parameters:
* `-e, --effective-date <date>`: Effective date in `YYYY-MM-DD` format. Defaults to today.
* `-r, --render-type <type>`: One of `PDF`, `HTML`, `CSV`, `JSON`, `METADATA`. Defaults to `PDF`.
* `-o, --output <path>`: Output file path (or directory). Defaults to the input filename with extension based on render type.
* `--env-file <path>`: Optional env file path for credential defaults.

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
