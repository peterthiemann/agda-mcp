#!/usr/bin/env python3
"""Stage only distributable plugin files and emit a stable ZIP plus SHA-256."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "stage", "pack"])
    args = parser.parse_args()
    manifest = json.loads((ROOT / "plugin.json").read_text())
    config = json.loads((ROOT / "mcp.json").read_text())
    version = manifest["version"]
    if json.loads((ROOT / "package.json").read_text())["version"] != version:
        raise SystemExit("Plugin and server package versions must agree")
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise SystemExit("Plugin version must be an exact X.Y.Z release")
    server = config["mcpServers"]["agda"]
    if server != {"type": "stdio", "command": "npx", "args": [
        "--yes", f"agda-mcp@{version}", "--dynamic-workspaces"
    ]}:
        raise SystemExit("Expected exact matching npm pin, dynamic workspaces, preview default")
    paths = [Path(name) for name in ("plugin.json", "mcp.json", "INSTALL.md", "LICENSE")]
    paths += sorted(p.relative_to(ROOT) for p in (ROOT / "skills" / "agda-proof").rglob("*") if p.is_file())
    if Path("skills/agda-proof/SKILL.md") not in paths:
        raise SystemExit("Missing skill entrypoint")
    for path in paths:
        source = ROOT / path
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(ROOT):
            raise SystemExit(f"Invalid package file: {path}")
    if args.action == "check":
        print(f"Plugin contract OK: {len(paths)} files; agda-mcp@{version}")
        return
    output = ROOT / ".plugin-build"
    stage = output / "agda-mcp-plugin"
    if stage.exists():
        shutil.rmtree(stage)
    for path in paths:
        target = stage / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / path, target)
    print(f"Staged {stage}")
    if args.action == "pack":
        archive = output / f"agda-mcp-plugin-{version}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as packed:
            for path in sorted(paths):
                info = zipfile.ZipInfo(f"agda-mcp-plugin/{path.as_posix()}", (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                packed.writestr(info, (stage / path).read_bytes())
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n")
        print(f"Packed {archive}\nSHA-256 {digest}")


if __name__ == "__main__":
    main()
