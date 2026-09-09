# Comms Cloud Release Management Guide

## Purpose

Use OCCS CLI smoke previews as a release-management check after a Comms Cloud deployment. The smoke run confirms that representative communications can still be rendered in the selected environment. It creates a local report and an **unsent** email draft; it never sends an email itself.

The smoke feature is intended to identify material rendering problems such as an unavailable package, an invalid document condition, missing content, or a preview failure. It is not a replacement for detailed document regression testing.

## Why smoke test Comms Cloud releases

Communication output depends on a chain of configuration: package selection, document conditions, layouts, content, styles, fonts, and the transaction data used to assemble the output. A migration can complete successfully while a dependency in that chain is missing, inactive, incorrectly associated, or behaves differently in the target tenancy. The resulting problem may only become visible when a real communication is assembled.

A smoke test is a fast, repeatable operational check that asks a narrower question than full regression testing: **can each representative communication still assemble and render in this tenancy?** It provides early evidence that the release has not caused a catastrophic rendering failure. It also produces a small, reviewable record rather than requiring reviewers to reproduce each preview manually.

The recommended sample set should cover the important package and condition branches. For example, the sample bill suite covers RT, NRT, BULK, and PLT alongside letter and eBill samples. Keep the suite deliberately small enough to run for every release, but broad enough to touch the communication families most affected by the change.

## Configuration lifecycle and migration context

Oracle Financial Services Cloud uses a progressive configuration lifecycle: configuration work starts in Non-Production, is moved to Pre-Production for isolated testing, and is then moved to Production for use. A Config ID groups related changes and tracks them through that lifecycle. [Oracle’s configuration lifecycle documentation](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/describesday1configurations/understanding-configuration-lifecycle.html)

In practical release terms:

1. Create and test configuration changes under a Config ID in **Non-Production**.
2. Close the Config ID when its changes are ready to freeze for movement. A closed Config ID cannot be reopened, and its changes are queued for movement. [Closing Config ID](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/oracle_financialservices_platform/closing-config-id.html)
3. Initiate movement to **Pre-Production from the target tenancy**—that is, from Pre-Production—not from Non-Production.
4. Perform isolation and release testing in **Pre-Production**. Oracle notes that configuration changes cannot be made there during this stage.
5. After approval, initiate movement to **Production from Production**. [Understanding Configuration Movement](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/describesday1configurations/day1-understanding-configuration-movement.html)

Configuration Movement is all-or-none for the eligible closed Config IDs in the source tenancy; it does not selectively move only a subset. That makes pre-movement checks especially valuable: a smoke failure discovered before movement is usually less disruptive to investigate than a failure discovered after a grouped migration. [Oracle configuration movement overview](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/oracle_financialservices_platform/understanding-configuration-movement.html)

### Why run before and after migration

Run the same suite at both points, but use the results for different decisions:

| Timing | Target | What it establishes | Release decision supported |
| --- | --- | --- | --- |
| **Before movement** | Source tenancy, normally Non-Production | The selected representative communications currently render successfully before their configuration is promoted. | Establishes a known-good reference and prevents promoting an already-broken configuration. |
| **After source → target movement** | Target environment, compared with source environment | The moved configuration is present and operational in the isolated target; comparison highlights unexpected visual change. | Supports isolation-test approval and readiness to move toward Production. |
| **Before target → Production movement** | Target environment | The approved, frozen configuration still renders in the final pre-production stage. | Provides final evidence before requesting or initiating production movement. |
| **After Production movement** | Production, where release controls permit it | The production tenant can assemble the representative outputs. | Confirms operational readiness; use a safe test-data and access process appropriate to Production. |

The compare mode is particularly useful immediately after Non-Production to Pre-Production movement. It separates two questions: whether both tenants generated an output, and whether the rendered result is generally the same. A visual **Review** is evidence to inspect—not an automatic release failure—because an intended configuration change can legitimately alter the output.

## Before you start

1. Install or update OCCS CLI.
2. Create saved sessions for the environments you will use. For example:

   ```sh
   occs login -c examplecustomer -r example-region -t <source-tenancy>
   occs login -c examplecustomer -r example-region -t <target-tenancy>
   ```

3. Keep a small, representative set of JSON or XML inputs. Each input should represent a meaningful communication path, rather than every possible scenario.
4. Confirm the communication package short name for each input.
5. Install the local PDF utilities used by the smoke command: Poppler (`pdftoppm` and `pdfinfo`) is required for thumbnails and PDF page counts. For two-environment visual comparison, also install ImageMagick (`identify` and `compare`). Ensure these commands are on `PATH` before running the suite.

On macOS, install them with `brew install poppler imagemagick`; on Ubuntu/Debian, use `sudo apt install poppler-utils imagemagick`. On Windows, install both tools and add their executable directories to `PATH`. Confirm the installation with `pdftoppm -v`, `pdfinfo -v`, and, when comparing environments, `identify -version` and `compare -version`.

For the sample bill suite, the representative bill samples are RT, NRT, BULK, and PLT. Letter and eBill inputs cover their respective packages.

## Create a smoke suite

Create a JSON suite file alongside the sample inputs. Input paths are resolved relative to the suite file.

```json
{
  "name": "Example release smoke",
  "tenancy": "<target-tenancy>",
  "tests": [
    { "id": "bill-rt", "type": "Bill RT", "package": "example_bills", "input": "bill-RT.json" },
    { "id": "bill-nrt", "type": "Bill NRT", "package": "example_bills", "input": "bill-NRT.json" },
    { "id": "bill-bulk", "type": "Bill BULK", "package": "example_bills", "input": "bill-BULK.json" },
    { "id": "bill-plt", "type": "Bill PLT", "package": "example_bills", "input": "bill-PLT.json" },
    { "id": "letter", "type": "Letter", "package": "example_letters", "input": "letter.json" },
    { "id": "ebill", "type": "eBill", "package": "example_email_body_ebill", "input": "eBill.json" }
  ]
}
```

PDF is the default render type and is recommended for release checks because it supports thumbnails and visual comparison. A test can request both formats when needed:

```json
{ "id": "bill-rt", "type": "Bill RT", "package": "example_bills", "input": "bill-RT.json", "renderTypes": ["PDF", "HTML"] }
```

## Run a single-environment smoke check

Run the suite against the release target. `--output` is a base directory name: OCCS CLI appends a local date/time suffix for every new run, preserving earlier release evidence automatically. For example, `--output ./smoke-output-target` creates a run directory such as `smoke-output-target-2026-08-25_14-30-15-123`.

```sh
occs smoke \
  --suite ./smoke-suite.json \
  --tenancy <target-tenancy> \
  --output ./smoke-output-target
```

A smoke result is:

- **Pass** — the selected environment returned a non-empty output for the requested format.
- **Fail** — input conversion, authentication, package preview, timeout, or output generation failed.

To retry a run without re-requesting successful previews, use `--resume` with the same output base. OCCS CLI selects the most recent matching date/time-stamped run directory, retains its existing non-empty outputs, and retries only missing or failed previews. In a comparison run, it does this independently for each environment:

```sh
occs smoke --suite ./smoke-suite.json --tenancy <target-tenancy> --output ./smoke-output-target --resume
```

Do not use `--resume` when a fresh post-deployment render is required; run the command without it. The new timestamped output directory provides an independent record of that rerun.

### Statement convenience runners

The checkout includes separate runners for the statement suite so that a normal smoke check is not confused with a visual comparison:

| Check | macOS | Windows | Default target(s) |
| --- | --- | --- | --- |
| Single-environment statement smoke test | `./run-smoke-stmt.zsh` | `run-smoke-stmt.bat` | `<source-tenancy>` |
| Statement comparison | `./run-smoke-compare-stmt.zsh` | `run-smoke-compare-stmt.bat` | `<source-tenancy>` → `<target-tenancy>` |

Both runners use `smoke-statements.json` beneath the statement samples directory. Set `OCCS_SAMPLES_DIR` or `OCCS_SMOKE_SUITE` if it has moved. Set `OCCS_SMOKE_TARGET` for the single-environment runner, or `OCCS_COMPARE_SOURCE` and `OCCS_COMPARE_TARGET` for the comparison runner. Each forwards `--resume` and other smoke options.

## Compare two environments

Use compare mode to validate a release target against a reference environment.

```sh
occs smoke \
  --suite ./smoke-suite.json \
  --tenancy <source-tenancy> \
  --compare-tenancy <target-tenancy> \
  --output ./smoke-output-source-vs-target
```

The report shows a thumbnail from each environment, the input filename, PDF page count, separate generation status, and a comparison result.

| Comparison result | Meaning | Release action |
| --- | --- | --- |
| **Pass** | Both PDFs rendered and their visual difference is within tolerance. | Continue normal release review. |
| **Review** | Both PDFs rendered, but at least one page differs beyond tolerance. | Inspect the side-by-side thumbnails and the difference image. Confirm whether the change is expected. |
| **N/A** | One or both environments did not produce a PDF. | Resolve the preview failure first. |

### How comparison works

OCCS CLI does not compare raw PDF bytes. PDF metadata, font packaging, and object ordering can differ even when the document looks the same. Instead, it:

1. Rasterizes every PDF page to an image.
2. Ignores small rendering noise using a 3% pixel fuzz.
3. Calculates the changed-pixel percentage for every page.
4. Uses the most-different page as the comparison result.

The default pass threshold is 1% changed pixels. Adjust it only when you have established that the variance is expected:

```sh
occs smoke \
  --suite ./smoke-suite.json \
  --tenancy <source-tenancy> \
  --compare-tenancy <target-tenancy> \
  --compare-threshold 0.02 \
  --output ./smoke-output-source-vs-target
```

`0.02` means 2%. A Review result is not automatically a release failure; it is a prompt for a human to check the output and approve or investigate the change.

## Review and distribute results

Each run creates the following artifacts in its new date/time-stamped output directory. The command prints the exact directory when it completes:

| Artifact | Purpose |
| --- | --- |
| `previews/` | Full generated PDF and/or HTML outputs, grouped by target in compare mode. |
| `thumbnails/` | First-page PNG thumbnails used by the report and email draft. |
| `comparisons/` | Rasterized pages and visual difference images for compare-mode review. |
| `smoke-results.json` | Machine-readable results for audit or automation. |
| `smoke-report.html` | Local, browser-viewable release report. |
| `smoke-email.html` | HTML version of the release email. |
| `smoke-email.eml` | Unsent email draft with embedded thumbnails. |

Open `smoke-report.html` to review the results. Its heading identifies the tested environment and generation time. Each result identifies the input file and lists the page count for generated PDFs. For a comparison, it identifies the comparison target environment and includes separate generation and visual-comparison counts. Open `smoke-email.eml` in Mail or Outlook, add recipients and any release context, then send it manually after review. The draft subject follows this pattern:

```text
Comms Cloud > <Environment> Smoke Test > <date and time>
```

The email includes generation counts and, for a comparison, visual-comparison pass, review, and failure counts.

## Using ATool and OCCS CLI for Config ID closure and migration

ATool and OCCS CLI use the same Comms configuration workflows, but serve different purposes:

| Tool | Best use in release management |
| --- | --- |
| **ATool** | Guided package editing, previewing a selected package and input, reviewing mappings and document conditions, publishing package changes to a chosen Config ID, and visually performing Config ID closure or migration. |
| **OCCS CLI** | Scriptable, repeatable operations: preflight checks, Config ID creation/closure, migration validation and initiation, preview generation, smoke-suite execution, and durable report artifacts. |

Use ATool where a reviewer needs to see and understand a communication. Use OCCS CLI where the activity must be repeatable, auditable, or suitable for a release checklist. They can be used together: ATool uses OCCS CLI for its Comms package, preview, Config ID closure, and migration actions.

### Configure ATool for the target environments

In ATool **User Settings**, set the OCCS session alias used for normal package and preview work. Set the **Config Source** and **Config Target** session aliases for movement activities, for example `np` and `pp`. If your organisation uses a naming convention for release Config IDs, add a Config ID Filter so the publish and close dialogues only offer the intended IDs.

The relevant ATool menu flows are:

- **Package → Preview…** — render and visually inspect a selected communication package and input.
- **Data → Convert and Map…** — convert/map data and review the fields and conditions that drive the output.
- **Config → Close…** — select an open Config ID from the configured source session, then close it.
- **Config → Migrate** — initiate movement using the configured source and target sessions.

After a successful closure, ATool offers to begin migration. Treat that prompt as a convenience, not a reason to skip the release checks below.

### Closure procedure

Before closing a Config ID, make sure the intended package, document, layout, content, style, and font changes are saved under the same Config ID. Use ATool’s package/publish workflow to inspect and publish the package changes; use ATool preview to confirm the selected representative inputs still assemble correctly.

Then perform a fresh source-tenancy smoke run and retain its artifacts. This is the last easy opportunity to prove that the configuration behaves as expected before it is frozen for movement.

**Using ATool**

1. Set the Config Source session to the source tenancy.
2. Choose **Config → Close…**.
3. Confirm the selected Config ID is the intended release bundle and that no related work remains open.
4. Confirm closure. Do not immediately migrate until the pre-migration smoke evidence has been reviewed.

**Using OCCS CLI**

```sh
# Optional: identify in-flight dependencies before release closure.
occs preflight --config-id <CONFIG_ID>

# Validate the intended Config ID without changing it.
occs close-config <CONFIG_ID> --session <source-tenancy> --dry-run

# Close it after approval.
occs close-config <CONFIG_ID> --session <source-tenancy>
```

Closing freezes the Config ID for movement. Oracle documents that a closed Config ID cannot be reopened; treat the `--dry-run` and release review as mandatory safeguards. [Oracle closing guidance](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/oracle_financialservices_platform/closing-config-id.html)

### Migration procedure

Configuration Movement is initiated from the **target** tenancy. For a Non-Production to Pre-Production release, use Pre-Production as the target. For a Pre-Production to Production release, use Production as the target. Confirm the eligible Config IDs and release scope before initiating movement, because the platform moves all eligible closed Config IDs in an all-or-none operation. [Oracle movement process](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/describesday1configurations/day1-understanding-configuration-movement.html)

**Using ATool**

1. Verify the source and target session aliases in User Settings.
2. Choose **Config → Migrate**.
3. Review the selected source/target and eligible release scope.
4. Initiate movement only after the source smoke run is approved.
5. When movement completes, run the target smoke suite and compare it with the source output.

**Using OCCS CLI**

```sh
# Inspect the target's eligible Config IDs without initiating movement.
occs migrate --source-session <source-tenancy> --target-tenancy <target-tenancy> --dry-run

# Optional sanity check: verify a named Config ID is eligible.
occs migrate <CONFIG_ID> --source-session <source-tenancy> --target-tenancy <target-tenancy> --dry-run

# Initiate the eligible movement after approval.
occs migrate --source-session <source-tenancy> --target-tenancy <target-tenancy>
```

Passing `<CONFIG_ID>` is a safeguard, not a selective migration mechanism: OCCS CLI verifies that it is eligible, but the Comms movement endpoint initiates movement for the full eligible set. Record the dry-run output in the release evidence.

## Establishing a regression-testing practice

Smoke testing is the release gate for basic renderability. Regression testing is the broader practice of confirming that expected behaviour remains correct after configuration changes. Use the two together.

### Build a versioned regression suite

Store the suite manifest and its inputs in source control or a controlled release-artifact repository. Give every test a stable ID, human-readable type, package short name, input file, and business purpose. Prefer production-like but non-sensitive data; sanitize or substitute customer information where required.

For each communication family, include tests that exercise the meaningful condition branches:

- Language and channel variants, such as English/Chinese, paper/eBill, or print/HTML.
- Tariff, product, service-agreement, or customer-segment branches.
- Important documents in a package, including conditional documents and common inserts.
- Edge cases that have previously caused incidents: final bills, adjustments, minimum charges, multipage outputs, charts, tables, barcode/QR content, and special fonts.

Use ATool to explore the package, inspect triggered/untriggered document mappings, and identify the input paths that distinguish these cases. Use OCCS CLI manifests to make the selected cases repeatable and runnable without manual UI setup.

### Use three levels of evidence

| Level | Question answered | Primary tool/workflow |
| --- | --- | --- |
| **Smoke** | Does each representative output generate? | `occs smoke`; ATool preview for targeted investigation. |
| **Visual regression** | Does the target output generally match the approved/reference tenancy? | `occs smoke --compare-tenancy ...`, report thumbnails, and `comparisons/` difference images. |
| **Business regression** | Are the required documents, data, calculations, conditions, and release rules correct? | ATool mapping and condition review, package preview, stakeholder review, and domain-specific assertions/checklists. |

Do not treat a visual Pass as proof that every business rule is correct. Conversely, do not treat every visual Review as a defect: approved content, layout, date, or configuration changes may alter the output legitimately.

### Operate the suite over time

1. Start with the minimum representative smoke suite used for every migration.
2. Add a case whenever a production defect, escaped issue, or significant condition branch is discovered.
3. Keep inputs stable unless the business scenario itself changes; changing both the configuration and the test input makes results harder to interpret.
4. Run a fresh suite before closure, after each migration, and after any urgent configuration repair.
5. Retain the suite version, generated PDFs, comparison report, difference images, and reviewed email draft with the release record.
6. Periodically remove duplicate cases, but do not remove historical incident cases without a documented replacement.

### Suggested release evidence

For each Config ID movement, capture:

- Config ID, source, target, release owner, and approval reference.
- The source smoke report produced before closure.
- The migration dry-run/eligible-list evidence.
- The target smoke and source-versus-target comparison report after movement.
- An explanation and approval for every visual Review or smoke failure.
- The final manually reviewed email draft or an equivalent release communication.

## Recommended release workflow

1. Confirm the deployment is complete in the target environment.
2. Run the single-environment smoke suite to confirm that all representative outputs generate.
3. If a suitable reference environment exists, run the two-environment comparison.
4. Investigate every **Fail** result and resolve or formally defer it.
5. Review every **Review** comparison result and inspect its difference image.
6. Open the generated email draft, add release-specific commentary and recipients, and send it manually.
7. Retain the output directory with the release evidence.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Saved-session error | Run `occs sessions`; use `--tenancy <source-tenancy>` / `--tenancy <target-tenancy>`, or provide the exact saved session key with `--session`. |
| One sample fails | Open its full preview and any error sidecar under `previews/`; verify the package name and sample payload. |
| Comparison is N/A | Confirm that both targets generated a PDF. HTML-only tests cannot be visually compared by this command. |
| Comparison is Review | Open the matching image under `comparisons/<test-id>/diff-page-<n>.png`; check whether the output change is expected before changing the threshold. |
| No thumbnails or PDF page counts | Install Poppler and ensure `pdftoppm` and `pdfinfo` are on `PATH`. Verify with `pdftoppm -v` and `pdfinfo -v`, then run the suite again. |
| Comparison is Review with a rendered-page-count warning | Install ImageMagick and ensure `identify` and `compare` are on `PATH`, then run the comparison again. |
| Email thumbnails do not display | Confirm PNG files were generated under `thumbnails/`; then regenerate the run with the current OCCS CLI version. The `.eml` draft embeds those images inline. |

## Oracle reference material

This guide applies the following Oracle Financial Services Cloud configuration-lifecycle and movement material to the OCCS CLI smoke-test workflow:

- [Understanding Configuration Lifecycle](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/describesday1configurations/understanding-configuration-lifecycle.html)
- [Understanding Configuration Movement](https://docs.oracle.com/en/industries/financial-services/financial-services-cloud/describesday1configurations/day1-understanding-configuration-movement.html)
- [Oracle topic reference: PLAFS-GUID-47C4E7D2-2EC1-4B44-B9A7-2300936956D5](https://docs.oracle.com/pls/topic/lookup?ctx=en/industries/financial-services/financial-services-cloud/describesday1configurations&id=PLAFS-GUID-47C4E7D2-2EC1-4B44-B9A7-2300936956D5)
- [Oracle topic reference: PLAFS-GUID-DFBBCC90-78E3-4E14-9494-2DBA79C0CCFD](https://docs.oracle.com/pls/topic/lookup?ctx=en/industries/financial-services/financial-services-cloud/describesday1configurations&id=PLAFS-GUID-DFBBCC90-78E3-4E14-9494-2DBA79C0CCFD)
- [Oracle topic reference: PLAFS-GUID-66E2AEBD-B816-4D4B-9A17-221530ED590F](https://docs.oracle.com/pls/topic/lookup?ctx=en/industries/financial-services/financial-services-cloud/describesday1configurations&id=PLAFS-GUID-66E2AEBD-B816-4D4B-9A17-221530ED590F)
- [Oracle topic reference: PLAFS-GUID-39275B91-F520-4FB5-85B9-967CD715A90F](https://docs.oracle.com/pls/topic/lookup?ctx=en/industries/financial-services/financial-services-cloud/describesday1configurations&id=PLAFS-GUID-39275B91-F520-4FB5-85B9-967CD715A90F)
- [Oracle topic reference: PLAFS-GUID-CDCB100A-E957-41ED-915E-5769DF33210F](https://docs.oracle.com/pls/topic/lookup?ctx=en/industries/financial-services/financial-services-cloud/describesday1configurations&id=PLAFS-GUID-CDCB100A-E957-41ED-915E-5769DF33210F)
