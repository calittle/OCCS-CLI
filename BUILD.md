# Build

## Automated Build Artifact

GitHub Actions builds a ZIP from every push to `main`. The ZIP is available
from the corresponding Actions run as an artifact. On a pushed version tag
such as `v1.1.1`, GitHub Actions runs the same validation and attaches the ZIP
to a GitHub Release, creating that release with generated notes if needed.

The build writes:

```text
dist/occs-cli-<version>-<timestamp>-<commit>.zip
```

The artifact contains the CLI package, supporting scripts, examples, and documentation:

* `bin/`
* `lib/`
* `tools/`
* Every root-level `.zsh` and `.bat` runner, including the smoke-test and smoke-comparison runners
* `README.md`, `BUILD.md`, `NOTES.MD`, `quickstart.txt`, and `docs/`
* `examples/` and `.occs-cli-build.local.json.example`
* `package.json`
* `package-lock.json`
* `BUILD_INFO.txt`

To publish a release, update the package version and push its tag:

```bash
npm version patch
git push origin main --follow-tags
```

For an existing tag whose release needs an asset added later, open the
**Publish release artifact** workflow in GitHub Actions, select **Run
workflow**, and provide the tag name. The workflow packages that exact tag.

### Build Manually

Build locally from the latest committed snapshot:

```bash
npm run build:artifact
```

Build from the current working tree:

```bash
npm run build:artifact:worktree
```
