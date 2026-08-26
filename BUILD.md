# Build

## Automated Build Artifact

This repo includes a local post-commit build hook. When enabled, each commit
builds a zip artifact from the committed `HEAD` snapshot and writes it to:

```text
dist/occs-cli-<version>-<timestamp>-<commit>.zip
```

The artifact contains the CLI package, supporting scripts, examples, hook, and documentation:

* `bin/`
* `lib/`
* `tools/` and `.githooks/`
* Every root-level `.zsh` and `.bat` runner, including the smoke-test and smoke-comparison runners
* `README.md`, `BUILD.md`, `NOTES.MD`, `quickstart.txt`, and `docs/`
* `examples/` and `.occs-cli-build.local.json.example`
* `package.json`
* `package-lock.json`
* `BUILD_INFO.txt`

If a local SharePoint/OneDrive sync folder is configured, the same artifact is
also copied there, along with a stable `occs-cli-latest.zip` file.

### Enable the Git Hook

Run this once from the repo root:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/post-commit tools/build_artifact.py
```

### Configure the SharePoint Destination

Use either an environment variable:

```bash
export OCCS_CLI_ARTIFACT_DIR="/path/to/local/SharePoint/folder"
```

Or create a local, ignored `.occs-cli-build.local.json` file:

```json
{
  "sharepoint_dir": "/path/to/local/SharePoint/folder"
}
```

The checked-in `.occs-cli-build.local.json.example` shows the expected shape.

### Build Manually

Build from the latest committed snapshot:

```bash
npm run build:artifact
```

Build from the current working tree:

```bash
npm run build:artifact:worktree
```
