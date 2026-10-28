#!/usr/bin/env python3
"""Package already-built binaries and WebUI; never include personal data."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import subprocess
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=("debug", "release"), default="release")
    parser.add_argument("--binary-dir", type=Path,
                        help="Already-built executable directory, for an external CARGO_TARGET_DIR")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts")
    args = parser.parse_args()
    version = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]["version"]
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
        parser.error("Commit the reviewed source and verification documents before packaging")
    suffix = ".exe" if platform.system() == "Windows" else ""
    binary_dir = args.binary_dir.resolve() if args.binary_dir else ROOT / "target" / args.profile
    files = []
    for name in ("rstrbot", "rstrbot-openai", "rstrbot-diagnostic", "rstrbot-webhook"):
        path = binary_dir / (name + suffix)
        if not path.is_file():
            parser.error(f"Build the workspace binaries first: missing {path.name}")
        files.append((path, path.name))
    web = ROOT / "web/dist"
    if not (web / "index.html").is_file():
        parser.error("Build the WebUI before packaging")
    files.extend((path, "web/" + path.relative_to(web).as_posix()) for path in web.rglob("*") if path.is_file())
    for name in ("README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "docs/OPERATIONS.md", "docs/ACCEPTANCE.md", "docs/IMPLEMENTATION_REPORT.md", "docs/DEVELOPER_TUTORIALS.md", ".agents/skills/rstrbot-development/SKILL.md", ".agents/skills/rstrbot-plugin-development/SKILL.md"):
        path = ROOT / name
        if not path.is_file():
            parser.error(f"Required release document is missing: {name}")
        files.append((path, name))
    for name in ("API_CONTRACT.md", "PLUGIN_PROTOCOL.md", "UI.md", "DESKTOP.md", "AUTHENTICATION.md", "IMPROVEMENTS_0_2_0.md", "openapi.json"):
        path = ROOT / "docs" / name
        if path.is_file():
            files.append((path, "docs/" + name))
    evidence = ROOT / "docs/evidence"
    files.extend((path, path.relative_to(ROOT).as_posix()) for path in evidence.rglob("*") if path.is_file())
    screenshots = ROOT / "docs/screenshots"
    files.extend((path, path.relative_to(ROOT).as_posix()) for path in screenshots.rglob("*.png") if path.is_file())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f"RstrBot-{version}-{platform.system().lower()}-{platform.machine()}-{args.profile}.zip"
    output = args.output_dir / name
    if output.exists():
        parser.error("Refusing to overwrite an existing package")
    manifest = {"version": version, "profile": args.profile, "os": platform.system(),
                "architecture": platform.machine(), "release_scope": "development_preview",
                "desktop_installers_verified": False,
                "build_environment": platform.platform(), "source_commit": revision, "files": {}}
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path, archive_name in sorted(files, key=lambda item: item[1]):
            contents = path.read_bytes()
            manifest["files"][archive_name] = hashlib.sha256(contents).hexdigest()
            archive.write(path, archive_name)
        archive.writestr("MANIFEST.json", json.dumps(manifest, indent=2) + "\n")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + ".sha256").write_text(f"{digest}  {output.name}\n")
    print(json.dumps({"path": str(output), "sha256": digest, "size": output.stat().st_size}, indent=2))


if __name__ == "__main__":
    main()
