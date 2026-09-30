# Notes

## 1.2.1 - 2026-09-30

- Show content styles and their attributes in the interactive mockup inspector.
- Add a sandboxed HTML preview for cached content, with readable field and conditional placeholders.
- List only fields used directly by the selected content; fields in conditional child content appear when that child is selected.

## 1.2.0 - 2026-09-26

- Add content-authoring commands for creating content, adding versions, and duplicating an existing content item or version while retaining its HTML and style relationships.
- Add content-browser commands with unscoped listing, type and name filtering, pagination, metadata inspection, and style-name resolution.
- Make content writes more reliable by matching the OCCS UI payload shape, resolving ConfigId names, normalizing version update collections, and producing clearer command errors.
- Improve mockup content navigation so repeated or nested content can be selected predictably in the interactive inspector.

## 1.1.10 - 2026-09-25

- Make full exports more fault tolerant: malformed or empty artifact index rows are reported and skipped, unavailable chart artifacts do not fail the whole export, and empty assembly templates are accepted.
- Add `--skip-refresh` to the refresh-and-mockups helpers and skip unavailable package documents during package mockup generation.
- Replace existing HTML blobs when downloading content so cached content reflects the current artifact.

## 1.1.9 - 2026-09-23

- Document the release ZIP upgrade workflow, including preserving inputs outside the extracted release directory and reinstalling the exact bundled dependencies.

## 1.1.8 - 2026-09-23

- Add HTML thumbnail images to smoke-test reports for faster visual triage.

## 1.1.7 - 2026-09-23

- Add HTML visual comparison reports to smoke-test runs.

## 1.1.6 - 2026-09-22

- Resume full CCS exports by default; `--resume` remains available for compatibility and `--fresh` forces a full re-download.

## 1.1.5 - 2026-09-22

- Add resumable, byte-verified full CCS exports that reuse completed unchanged artifacts and retry only missing, changed, corrupt, pending, or failed files.

## 1.1.4 - 2026-09-22

- Show assembly-template document conditions and more complete package details in generated mockup inspectors.

## 1.1.3 - 2026-09-14

- Add portable Zsh and PowerShell examples for refreshing a cache and generating selected package mockups.

## 1.1.2 - 2026-09-09

- Flatten JSON output by default to improve Comms processing speed: JSON written or submitted by the CLI now omits formatting whitespace and strips `\n`, `\r`, and `\t` from JSON string values and object keys.
- Add global `--pretty` to preserve the previous indented JSON output and string whitespace behavior when needed.
- Apply flattened JSON serialization to Comms-facing preview `AssemblyData`, package assembly-template uploads, JSON sidecars, bundle artifacts, and machine-readable stdout.
- Speed up bulk artifact exports with bounded concurrent downloads; use `--concurrency` to tune request pressure for a tenant.
- Share token refreshes across concurrent export requests, avoiding duplicate logins and competing session writes.
- Reduce repeated cache reads in mockup and cross-reference report generation.
- Run paired smoke comparison previews concurrently by default; pass `occs smoke --concurrency 1` for sequential execution.

## 1.1.1 - 2026-09-09

- Add automated GitHub release builds that replace an earlier ZIP asset when a release is rebuilt.
- Report the CLI version from package metadata and retry expired OCCS sessions during exports.
- License the CLI under GPL-3.0-only and mark it as unofficial and unsupported.

## 1.1.0 - 2026-09-03

- Add package maintenance, configuration lifecycle, preview, preflight, XML conversion, and email preview/dry-run commands.
- Add recoverable exports for fonts and artifacts, transient download retries, configurable request timeouts, encrypted saved credentials, and session refresh support.
- Add cached interactive document mockups, package-wide mockup generation, chart exports, targeted artifact downloads, and content-reference cross-reference reporting.
- Add smoke-test runners for multiple environments, statement XML, PDF page counts, resume behavior, timestamped output, and summarized comparisons.
