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

Unsure what to use? Look at the URL used to access CCS:
`https://[customer].[region].oraclecloud.com/[tenancy]/ui/Configuration/index.html`

#### get-everything
Downloads all CCS data including packages, documents, layouts, contents, styles, and fonts.

`occs-cli get-everything`

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
