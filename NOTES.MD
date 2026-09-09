# Notes

## 1.1.2 - 2026-09-09

- Flatten JSON output by default to improve Comms processing speed: JSON written or submitted by the CLI now omits formatting whitespace and strips `\n`, `\r`, and `\t` from JSON string values and object keys.
- Add global `--pretty` to preserve the previous indented JSON output and string whitespace behavior when needed.
- Apply flattened JSON serialization to Comms-facing preview `AssemblyData`, package assembly-template uploads, JSON sidecars, bundle artifacts, and machine-readable stdout.
- Speed up bulk artifact exports with bounded concurrent downloads; use `--concurrency` to tune request pressure for a tenant.
- Share token refreshes across concurrent export requests, avoiding duplicate logins and competing session writes.
- Reduce repeated cache reads in mockup and cross-reference report generation.
- Run paired smoke comparison previews concurrently by default; pass `occs smoke --concurrency 1` for sequential execution.
