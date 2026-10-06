#!/usr/bin/env python3
"""Scan source files or fetched Git history without printing credential values."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--history", action="store_true", help="scan all fetched refs; requires a full fetch")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
scanner = shutil.which("gitleaks")
if not scanner:
    parser.error("Install Gitleaks 8.30.1 before running this check")
if subprocess.check_output([scanner, "version"], text=True).strip() != "8.30.1":
    parser.error("Use Gitleaks 8.30.1 so local and CI rules match")
common = ["--redact=100", "--no-banner", "--ignore-gitleaks-allow"]
if args.history:
    shallow = subprocess.check_output(["git", "rev-parse", "--is-shallow-repository"], cwd=root, text=True).strip()
    if shallow != "false":
        parser.error("History readiness requires an unshallow fetch of all branches and tags")
    result = subprocess.run([scanner, "git", *common, "--log-opts=--all", str(root)], cwd=root)
else:
    # Includes uncommitted source changes but excludes ignored .env/dependencies.
    files = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
    with tempfile.TemporaryDirectory(prefix="keeper-source-scan-") as temp:
        for name in filter(None, files):
            source = root / name
            if source.is_symlink():
                parser.error("Review source symlinks before scanning: " + name)
            if not source.is_file():
                continue
            target = Path(temp) / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        result = subprocess.run([scanner, "dir", *common, temp], cwd=root)
raise SystemExit(result.returncode)
