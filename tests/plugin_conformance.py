#!/usr/bin/env python3
"""Run identical protocol vectors against actual independent SDK processes."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / "sdk/conformance.json").read_text())


def exercise(command, case=None, rejected=False):
    with tempfile.TemporaryDirectory(prefix="rb-sdk-") as directory:
        endpoint = str(Path(directory) / "rpc")
        token = secrets.token_hex(32)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(endpoint)
        os.chmod(endpoint, 0o600)
        server.listen(1)
        server.settimeout(8)
        environment = {"PATH": os.environ.get("PATH", ""), "RSTRBOT_SOCKET": endpoint,
                       "RSTRBOT_TOKEN": token, "RSTRBOT_CONTEXT": json.dumps(VECTORS["context"])}
        worker = subprocess.Popen(command, cwd=directory, env=environment,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            connection, _ = server.accept()
            connection.settimeout(8)
            with connection, connection.makefile("rwb") as wire:
                def send(value):
                    wire.write(json.dumps(value, ensure_ascii=False).encode() + b"\n")
                    wire.flush()

                def receive():
                    line = wire.readline(1024 * 1024 + 2)
                    assert line.endswith(b"\n") and len(line) <= 1024 * 1024 + 1, "Missing/oversized frame"
                    value = json.loads(line)
                    assert value["jsonrpc"] == "2.0", value
                    return value

                send({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
                    "protocol_version":"1.0","token":"wrong" if rejected else token,
                    "context":VECTORS["context"]}})
                hello = receive()
                assert hello["id"] == "init", hello
                if rejected:
                    assert hello["error"]["code"] == -32001, hello
                    return
                assert hello["result"]["protocol_version"] == "1.0", hello
                for key, value in VECTORS["context"].items():
                    assert hello["result"][key] == value, hello
                assert "tools" in hello["result"]["capabilities"], hello
                send({"jsonrpc":"2.0","id":"call-1","method":case["method"],"params":case["params"]})
                events = []
                for _ in range(32):
                    response = receive()
                    if "method" not in response:
                        break
                    assert response["params"]["request_id"] == "call-1", response
                    events.append(response["method"])
                else:
                    raise AssertionError("Missing terminal response")
                assert response["id"] == "call-1", response
                if "expect_error" in case:
                    assert response["error"]["code"] == case["expect_error"], response
                else:
                    assert "error" not in response, response
                    result = response["result"]
                    if "expect_content" in case:
                        assert result["content"] == case["expect_content"], result
                    if "expect_tool" in case:
                        assert case["expect_tool"] in [tool["name"] for tool in result["tools"]], result
                    if "expect_event" in case:
                        assert case["expect_event"] in events, events
        finally:
            server.close()
            try:
                worker.wait(timeout=3)
            except subprocess.TimeoutExpired:
                worker.kill()
                worker.wait()
            if worker.stderr:
                worker.stderr.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-all", action="store_true")
    parser.add_argument("--sdk", choices=["all", "python", "typescript", "rust", "csharp"], default="all")
    parser.add_argument("--rust-bin", default=str(ROOT / "target/debug/rstrbot-diagnostic"))
    parser.add_argument("--dotnet-dll", default=str(ROOT / "sdk/csharp/EchoPlugin/bin/Debug/net10.0/EchoPlugin.dll"))
    options = parser.parse_args()
    commands = {
        "python": [sys.executable, str(ROOT / "sdk/python/examples/echo.py")],
        "typescript": [shutil.which("node") or "node", str(ROOT / "sdk/typescript/examples/echo.mjs")],
        "rust": [options.rust_bin],
        "csharp": [shutil.which("dotnet") or "dotnet", options.dotnet_dll],
    }
    report = {"protocol_version":"1.0", "passed":0, "failed":0, "sdks":{}}
    for name, command in commands.items():
        if options.sdk not in ("all",name):
            continue
        available = Path(command[0]).exists() and (name != "csharp" or Path(command[1]).exists())
        if name == "typescript":
            available = available and (ROOT / "sdk/typescript/dist/index.js").exists()
        if not available:
            report["sdks"][name] = {"status":"not_executed", "reason":"Runtime or built example is unavailable"}
            if options.require_all or options.sdk != "all": report["failed"] += 1
            continue
        completed = []
        try:
            for case in VECTORS["cases"]:
                exercise(command, case)
                completed.append(case["name"])
            exercise(command, rejected=True)
            completed.append("invalid initialization proof rejected")
            report["sdks"][name] = {"status":"passed", "cases":completed}
            report["passed"] += len(completed)
        except Exception as error:
            report["sdks"][name] = {"status":"failed", "passed_cases":completed, "error":str(error)}
            report["failed"] += 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(report["failed"] != 0)


if __name__ == "__main__":
    raise SystemExit(main())
