#!/usr/bin/env python3
"""Verify hashes, extract and run a packaged Linux distribution in isolation.

The fixture is temporary and uses only the explicitly labeled diagnostic model.
It launches outside the checkout with no --web-dir override, so the test catches
missing adjacent workers, executable permissions and WebUI packaging errors.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
from integration import Client  # noqa: E402

BINARIES = ("rstrbot", "rstrbot-openai", "rstrbot-diagnostic", "rstrbot-webhook")
DEVELOPER_DOCUMENTS = (
    "docs/DEVELOPER_TUTORIALS.md",
    ".agents/skills/rstrbot-development/SKILL.md",
    ".agents/skills/rstrbot-plugin-development/SKILL.md",
)


def verify(archive, report):
    with tempfile.TemporaryDirectory(prefix="rstrbot-package-") as temporary:
        temporary = Path(temporary)
        distribution = temporary / "distribution"
        distribution.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            infos = bundle.infolist()
            assert sum(info.file_size for info in infos) <= 160 * 1024 * 1024, "Unexpected expanded size"
            assert len({info.filename for info in infos}) == len(infos), "Duplicate archive path"
            manifest = json.loads(bundle.read("MANIFEST.json"))
            for info in infos:
                path = PurePosixPath(info.filename)
                assert not path.is_absolute() and ".." not in path.parts
                mode = info.external_attr >> 16
                assert not stat.S_ISLNK(mode), "No symbolic links are expected in this package"
                if info.is_dir():
                    continue
                contents = bundle.read(info)
                if info.filename != "MANIFEST.json":
                    assert hashlib.sha256(contents).hexdigest() == manifest["files"][info.filename], info.filename
                target = distribution.joinpath(*path.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents)
                if info.filename in BINARIES:
                    assert mode & 0o111, "Executable mode was not recorded"
                    target.chmod(0o700)
            assert set(manifest["files"]) == {info.filename for info in infos if not info.is_dir()} - {"MANIFEST.json"}
            assert all((distribution / name).is_file() for name in BINARIES)
            assert all((distribution / name).is_file() for name in DEVELOPER_DOCUMENTS)
            report["source_commit"] = manifest["source_commit"]
            report["binary_sha256"] = {name: manifest["files"][name] for name in BINARIES}
            report["checks"].append("archive paths, executable modes and every manifest file SHA-256 verified")
            report["checks"].append("embedded developer tutorials and both project skills are present in the release archive")
        environment = {key: value for key, value in os.environ.items() if not key.startswith("RSTRBOT_")}
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        data = temporary / "isolated-data"
        log_path = temporary / "server.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen([str(distribution / "rstrbot"), "--data-dir", str(data), "--listen", f"127.0.0.1:{port}"],
                                       cwd=temporary, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                client = Client(f"http://127.0.0.1:{port}")
                deadline = time.monotonic() + 20
                while True:
                    assert process.poll() is None, "Packaged core exited before startup"
                    try:
                        setup = client.get("/api/v1/setup")
                        break
                    except (urllib.error.URLError, ConnectionError):
                        if time.monotonic() >= deadline:
                            raise AssertionError("Packaged core did not become ready")
                        time.sleep(0.05)
                assert setup["initialized"] is False
                html = client.get("/")
                assert '<div id="root">' in html or '<div id="root"' in html
                assert client.get("/api/v1/openapi.json") == json.loads((distribution / "docs/openapi.json").read_text())
                report["checks"].append("extracted core serves adjacent WebUI and exact OpenAPI outside the checkout without Node.js")
                client.post("/api/v1/setup", {"token": (data / "bootstrap.token").read_text().strip(),
                            "username": "package-fixture", "password": "isolated package verification password", "workspace": "Package verification"})
                workspace = client.get("/api/v1/workspaces")["items"][0]["id"]
                installed = client.get("/api/v1/plugin-packages")["items"]
                assert {item["id"] for item in installed} >= {"openai", "diagnostic", "webhook"}
                model = client.post(f"/api/v1/workspaces/{workspace}/resources/models", {
                    "visibility": "private", "data": {"name": "Package fixture", "provider": "diagnostic", "model": "diagnostic"}})
                result = client.post(f"/api/v1/workspaces/{workspace}/models/{model['id']}/test")
                assert result["fixture"] is True and result["success"] is True
                report["checks"].append("first-time setup and actual adjacent diagnostic worker invocation pass from extracted package")
                process.send_signal(signal.SIGTERM)
                assert process.wait(timeout=15) == 0
                report["checks"].append("packaged core exits successfully through bounded SIGTERM shutdown")
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    report = {"status": "running", "verified_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "platform": platform.platform(), "archive": options.archive.name,
              "archive_sha256": hashlib.sha256(options.archive.read_bytes()).hexdigest(), "checks": [],
              "scope": "Linux extracted-package acceptance with local diagnostic worker, not a paid model or a native desktop installer"}
    try:
        verify(options.archive, report)
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
    options.output.parent.mkdir(parents=True, exist_ok=True)
    options.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return int(report["status"] != "passed")


if __name__ == "__main__":
    raise SystemExit(main())
