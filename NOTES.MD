# Notes

## Unreleased

- Flatten JSON output by default to improve Comms processing speed: JSON written or submitted by the CLI now omits formatting whitespace and strips `\n`, `\r`, and `\t` from JSON string values and object keys.
- Add global `--pretty` to preserve the previous indented JSON output and string whitespace behavior when needed.
- Apply flattened JSON serialization to Comms-facing preview `AssemblyData`, package assembly-template uploads, JSON sidecars, bundle artifacts, and machine-readable stdout.
