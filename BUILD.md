# Build

## Automated Build Artifact

GitHub Actions tests, builds and publishes the ZIP when a version tag (`v*`)
is pushed. Commits to `main` do not trigger builds. The workflow attaches the
ZIP to the GitHub Release and uses that version's section in `NOTES.MD` for
release notes. A manual run can rebuild an existing tag.

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

## SSO runtime and validation

Browser SSO is available from OCCS CLI 1.4.0. Retain `playwright-core` and
`tough-cookie` in the packaged dependencies and lockfile. A standalone Chrome,
Edge or Chromium installation is required on the user's machine; the CLI does
not bundle a browser. `--browser-executable` or `OCCS_SSO_BROWSER` can override
automatic detection. SSO does not require a Microsoft client secret or a HAR.

Release tests use synthetic sessions. They check encrypted cookie storage,
request authentication, cookie updates, concurrent session writes, expiry
handling and redaction without a live phone/passkey sign-in. Live acceptance
checks require an actual browser sign-in, a separate CLI read after the browser
closes, and preview with a known working package/input pair. Other writes and
session expiry/renewal require separate live checks.

Never package a HAR, session store, credential key or user-generated preview.
Native ATool builds select the latest published stable OCCS release at build
time; existing ATool installations retain their bundled version. An ATool build
must also contain its SSO UI changes to expose browser sign-in from the app.
