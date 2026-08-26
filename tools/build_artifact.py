#!/usr/bin/env python3
"""Build a distributable OCCS CLI zip and optionally copy it to a local destination."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path


PACKAGE_PATHS = (
    "bin",
    "lib",
    "README.md",
    "BUILD.md",
    "NOTES.MD",
    "quickstart.txt",
    "docs",
    "examples",
    "tools",
    ".githooks",
    ".occs-cli-build.local.json.example",
    "package.json",
    "package-lock.json",
)
LOCAL_CONFIG_FILE = ".occs-cli-build.local.json"
ARTIFACT_ENV_VAR = "OCCS_CLI_ARTIFACT_DIR"
DEFAULT_LATEST_NAME = "occs-cli-latest.zip"
EXCLUDED_PACKAGE_PARTS = {"__pycache__"}
EXCLUDED_PACKAGE_NAMES = {".DS_Store"}


def package_file(path: Path) -> bool:
    return path.is_file() and not (
        any(part in EXCLUDED_PACKAGE_PARTS for part in path.parts)
        or path.name in EXCLUDED_PACKAGE_NAMES
        or path.name.startswith("~$")
    )


def run_git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=check,
        capture_output=True,
        text=True,
    )


def find_repo_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return Path(result.stdout.strip()).resolve()
    return Path(__file__).resolve().parents[1]


def git_value(repo_root: Path, *args: str, default: str = "") -> str:
    result = run_git(repo_root, *args, check=False)
    if result.returncode != 0:
        return default
    return result.stdout.strip() or default


def load_local_config(repo_root: Path) -> dict[str, object]:
    config_path = repo_root / LOCAL_CONFIG_FILE
    if not config_path.exists():
        return {}
    with config_path.open("r", encoding="utf-8") as source:
        config = json.load(source)
    if not isinstance(config, dict):
        raise ValueError(f"{LOCAL_CONFIG_FILE} must contain a JSON object.")
    return config


def resolve_destination(args: argparse.Namespace, config: dict[str, object]) -> Path | None:
    configured = args.dest or os.environ.get(ARTIFACT_ENV_VAR) or config.get("sharepoint_dir")
    if configured is None:
        return None
    destination = Path(str(configured)).expanduser()
    return destination.resolve()


def collect_package_files(repo_root: Path, source: str) -> list[str]:
    if source == "head":
        packaged_files = set(run_git(repo_root, "ls-tree", "-r", "--name-only", "HEAD", "--", *PACKAGE_PATHS).stdout.splitlines())
        root_files = set(run_git(repo_root, "ls-tree", "--name-only", "HEAD").stdout.splitlines())
        return sorted(
            line
            for line in packaged_files | root_files
            if line and package_file(Path(line)) and (line in packaged_files or Path(line).suffix.lower() in {".zsh", ".bat"})
        )

    files: list[str] = []
    for relative_path in PACKAGE_PATHS:
        path = repo_root / relative_path
        if path.is_dir():
            files.extend(
                sorted(
                    item.relative_to(repo_root).as_posix()
                    for item in path.rglob("*")
                    if package_file(item)
                )
            )
        elif path.is_file():
            files.append(relative_path)
    files.extend(
        item.relative_to(repo_root).as_posix()
        for item in repo_root.iterdir()
        if package_file(item) and item.suffix.lower() in {".zsh", ".bat"}
    )
    return sorted(dict.fromkeys(files))


def read_package_file(repo_root: Path, relative_path: str, source: str) -> bytes:
    file_path = repo_root / relative_path
    if source == "worktree":
        return file_path.read_bytes()

    result = subprocess.run(
        ["git", "-C", str(repo_root), "show", f"HEAD:{relative_path}"],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Could not read {relative_path} from HEAD.")
    return result.stdout


def read_package_json(repo_root: Path, source: str) -> dict[str, object]:
    raw = read_package_file(repo_root, "package.json", source)
    package_json = json.loads(raw.decode("utf-8"))
    if not isinstance(package_json, dict):
        raise ValueError("package.json must contain a JSON object.")
    return package_json


def safe_artifact_part(value: object, default: str) -> str:
    text = str(value or default).strip() or default
    return "".join(char if char.isalnum() or char in ("-", "_", ".") else "-" for char in text)


def materialize_snapshot(repo_root: Path, file_names: list[str], source: str, target_dir: Path) -> None:
    for relative_path in file_names:
        target_path = target_dir / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_bytes(read_package_file(repo_root, relative_path, source))


def check_js_syntax(snapshot_dir: Path) -> None:
    node_cmd = shutil.which("node")
    if node_cmd is None:
        raise RuntimeError("Node.js is required to validate the OCCS CLI package.")

    js_files = sorted(
        item
        for folder in ("bin", "lib")
        for item in (snapshot_dir / folder).rglob("*.js")
    )
    for js_file in js_files:
        result = subprocess.run(
            [node_cmd, "--check", str(js_file)],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            details = (result.stderr or result.stdout).strip()
            raise RuntimeError(f"Syntax check failed for {js_file.relative_to(snapshot_dir)}:\n{details}")


def validate_package(repo_root: Path, file_names: list[str], source: str) -> None:
    missing = [relative_path for relative_path in ("bin/occs.js", "package.json") if relative_path not in file_names]
    if missing:
        raise RuntimeError(f"Package is missing required file(s): {', '.join(missing)}")

    read_package_json(repo_root, source)
    if "package-lock.json" in file_names:
        json.loads(read_package_file(repo_root, "package-lock.json", source).decode("utf-8"))

    with tempfile.TemporaryDirectory(prefix="occs-cli-build-") as temp_dir:
        snapshot_dir = Path(temp_dir)
        materialize_snapshot(repo_root, file_names, source, snapshot_dir)
        check_js_syntax(snapshot_dir)


def build_zip(repo_root: Path, dist_dir: Path, source: str) -> Path:
    file_names = collect_package_files(repo_root, source)
    validate_package(repo_root, file_names, source)

    package_json = read_package_json(repo_root, source)
    package_name = safe_artifact_part(package_json.get("name"), "occs-cli")
    version = safe_artifact_part(package_json.get("version"), "local")
    dist_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    commit_sha = git_value(repo_root, "rev-parse", "--short", "HEAD", default="local")
    artifact_path = dist_dir / f"{package_name}-{version}-{timestamp}-{commit_sha}.zip"
    full_commit_sha = git_value(repo_root, "rev-parse", "HEAD", default="local")

    with zipfile.ZipFile(artifact_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative_path in file_names:
            archive.writestr(relative_path, read_package_file(repo_root, relative_path, source))
        archive.writestr(
            "BUILD_INFO.txt",
            "\n".join(
                [
                    f"artifact={artifact_path.name}",
                    f"package={package_json.get('name', 'occs-cli')}",
                    f"version={package_json.get('version', 'local')}",
                    f"source={source}",
                    f"commit={full_commit_sha}",
                    f"built_at={datetime.now().isoformat(timespec='seconds')}",
                    f"files={len(file_names)}",
                ]
            )
            + "\n",
        )
    return artifact_path


def copy_to_destination(artifact_path: Path, destination: Path, latest_name: str | None) -> list[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    copied_paths = [destination / artifact_path.name]
    shutil.copy2(artifact_path, copied_paths[0])
    if latest_name:
        latest_path = destination / latest_name
        shutil.copy2(artifact_path, latest_path)
        copied_paths.append(latest_path)
    return copied_paths


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        choices=("head", "worktree"),
        default="head",
        help="Build from the committed HEAD snapshot or the current worktree.",
    )
    parser.add_argument(
        "--dest",
        help=f"Directory to copy the artifact to. Defaults to {ARTIFACT_ENV_VAR} or {LOCAL_CONFIG_FILE}.",
    )
    parser.add_argument(
        "--dist-dir",
        help="Local artifact output directory. Defaults to <repo>/dist.",
    )
    parser.add_argument(
        "--latest-name",
        default=DEFAULT_LATEST_NAME,
        help="Optional stable filename to update in the destination directory.",
    )
    parser.add_argument(
        "--no-latest",
        action="store_true",
        help="Do not write a stable latest artifact filename in the destination directory.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = find_repo_root()
    config = load_local_config(repo_root)
    dist_dir = Path(args.dist_dir).expanduser().resolve() if args.dist_dir else repo_root / "dist"
    latest_name = None if args.no_latest else args.latest_name

    artifact_path = build_zip(repo_root, dist_dir, args.source)
    print(f"Built {artifact_path}")

    destination = resolve_destination(args, config)
    if destination is None:
        print(
            "No SharePoint destination configured. Set "
            f"{ARTIFACT_ENV_VAR} or {LOCAL_CONFIG_FILE} to enable copying."
        )
        return 0

    copied_paths = copy_to_destination(artifact_path, destination, latest_name)
    for copied_path in copied_paths:
        print(f"Copied {copied_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
