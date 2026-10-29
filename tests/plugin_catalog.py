import json
import time
import uuid
import tempfile
import threading
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from integration import Client, Instance, PASSWORD, wait_for

binary = Path("target/debug/rstrbot").resolve()
requests = []


class Provider(BaseHTTPRequestHandler):
    def do_POST(self):
        requests.append(self.path)
        body = json.dumps(
            {
                "id": "fixture",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "unexpected model request",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


receiver = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=receiver.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix="rstrbot-tools-probe-") as temp:
    instance = Instance(Path(temp) / "core", binary, allow_private_network=True)
    try:
        worker = Path(temp) / "catalog_worker.py"
        sdk = Path("sdk/python").resolve()
        worker.write_text(
            "import asyncio, sys\n"
            f"sys.path.insert(0, {str(sdk)!r})\n"
            "from rstrbot_sdk import Plugin, RpcFailure, serve\n"
            "async def handle(method, params, call):\n"
            " if method == 'tools.list':\n"
            "  count = params.get('config', {}).get('count', 32)\n"
            "  return {'tools': [{'name': f'tool_{i}', 'effect':'read_only', 'input_schema':{'type':'object'}} for i in range(count)]}\n"
            " if method == 'tools.call': return {'content':'catalog fixture result', 'effect':'read_only'}\n"
            " raise RpcFailure(-32601, 'not found')\n"
            "asyncio.run(serve(Plugin(('tools',), handle)))\n"
        )
        manifest = Path(temp) / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "id": "catalog-fixture",
                    "version": "1.0.0",
                    "executable": sys.executable,
                    "args": [str(worker)],
                    "capabilities": ["tools"],
                    "permissions": [],
                }
            )
        )
        subprocess.run(
            instance.command("plugin-install", "--manifest", str(manifest)),
            env=instance.environment,
            check=True,
            capture_output=True,
        )
        instance.start()
        client = Client(instance.base)
        client.post(
            "/api/v1/setup",
            {
                "token": (instance.directory / "bootstrap.token").read_text(),
                "username": "tool-probe",
                "password": PASSWORD,
                "workspace": "Tool probe",
            },
        )
        wid = client.get("/api/v1/workspaces")["items"][0]["id"]
        base = "/api/v1/workspaces/" + wid

        def create(kind, data, visibility="private"):
            return client.post(
                base + "/resources/" + kind, {"visibility": visibility, "data": data}
            )

        model = create(
            "models",
            {
                "name": "Probe",
                "provider": "diagnostic",
                "model": "diagnostic",
                "max_tokens": 1024,
            },
            "workspace",
        )
        plugin = create(
            "plugins",
            {
                "name": "Existing enabled tool",
                "package_id": "diagnostic",
                "enabled": True,
                "config": {},
            },
            "workspace",
        )

        def run(mode, label, selected_model=model):
            conversation = create("conversations", {"title": label})
            prompt = "/diagnostic/tool " + label
            if mode == "chat":
                started = client.post(
                    base + "/chat",
                    {
                        "conversation_id": conversation["id"],
                        "model_id": selected_model["id"],
                        "content": prompt,
                        "idempotency_key": str(uuid.uuid4()),
                    },
                )
                rid = started["run"]["id"]
            else:
                schedule = create(
                    "schedules",
                    {
                        "title": label,
                        "prompt": prompt,
                        "conversation_id": conversation["id"],
                        "model_id": selected_model["id"],
                        "enabled": True,
                        "schedule_type": "once",
                        "at": int(time.time()) + 4,
                    },
                )
                item = wait_for(
                    lambda: client.get(base + "/resource/" + schedule["id"]),
                    lambda x: bool(x["data"].get("last_result")),
                    timeout=35,
                )
                rid = item["data"]["run_id"]
            r = wait_for(
                lambda: client.get(base + "/runs/" + rid),
                lambda x: (
                    x["data"]["status"]
                    in ("completed", "failed", "cancelled", "interrupted")
                ),
                timeout=30,
            )
            messages = client.get(
                base + "/conversations/" + conversation["id"] + "/messages"
            )["items"]
            return {
                "mode": mode,
                "status": r["data"]["status"],
                "content": r["data"].get("content"),
                "error": r["data"].get("error"),
                "error_code": r["data"].get("error_code"),
                "tool_results": sum(m.get("role") == "tool" for m in messages),
            }

        out = [run("chat", "initial-interactive"), run("schedule", "initial-scheduled")]
        initial = int(time.time())
        while int(time.time()) == initial:
            time.sleep(0.05)
        for index in range(100):
            create(
                "plugins",
                {
                    "name": f"Disabled {index:03}",
                    "package_id": "diagnostic",
                    "enabled": False,
                    "config": {},
                },
                "workspace",
            )
        rows = client.get(base + "/resources/plugins?limit=100")["items"]
        print(
            json.dumps(
                {
                    "enabled_in_first_page": sum(p["id"] == plugin["id"] for p in rows),
                    "page_count": len(rows),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        out.extend([run("chat", "many-interactive"), run("schedule", "many-scheduled")])
        assert all(
            result["status"] == "completed" and result["tool_results"] == 1
            for result in out
        ), out
        for index in range(63):
            create(
                "plugins",
                {
                    "name": f"Enabled {index:03}",
                    "package_id": "diagnostic",
                    "enabled": True,
                    "config": {},
                },
                "workspace",
            )
        boundary = run("chat", "exactly-64-tools")
        assert boundary["status"] == "completed" and boundary["tool_results"] == 1, (
            boundary
        )
        create(
            "plugins",
            {
                "name": "Enabled 65th",
                "package_id": "diagnostic",
                "enabled": True,
                "config": {},
            },
            "workspace",
        )
        fake_model = create(
            "models",
            {
                "name": "Local request ledger",
                "provider": "openai",
                "model": "ledger",
                "base_url": f"http://127.0.0.1:{receiver.server_port}/v1",
                "allow_private_network": True,
            },
            "workspace",
        )
        overflow = [
            run("chat", "overflow-chat", fake_model),
            run("schedule", "overflow-scheduled", fake_model),
        ]
        assert all(
            result["status"] == "failed"
            and result["error_code"] == "tool_catalog_tool_limit"
            and result["tool_results"] == 0
            for result in overflow
        ), overflow
        assert requests == [], requests
        # An independently installed Python SDK worker supplies an exact
        # per-plugin boundary, rather than relying on the diagnostic worker.
        second = client.post("/api/v1/workspaces", {"name": "Per-plugin boundary"})
        base = "/api/v1/workspaces/" + second["id"]
        isolated_model = create(
            "models",
            {"name": "Diagnostic", "provider": "diagnostic", "model": "diagnostic"},
            "workspace",
        )
        exact_plugin = create(
            "plugins",
            {
                "name": "32 tools",
                "package_id": "catalog-fixture",
                "enabled": True,
                "config": {"count": 32},
            },
            "workspace",
        )
        exact = run("chat", "exactly-32-tools", isolated_model)
        assert (
            exact["status"] == "completed"
            and exact["tool_results"] == 1
            and "catalog fixture result" in exact["content"]
        ), exact
        client.request(
            "DELETE",
            base
            + "/resource/"
            + exact_plugin["id"]
            + "?version="
            + str(exact_plugin["version"]),
            expect=(204,),
        )
        create(
            "plugins",
            {
                "name": "33 tools",
                "package_id": "catalog-fixture",
                "enabled": True,
                "config": {"count": 33},
            },
            "workspace",
        )
        isolated_ledger = create(
            "models",
            {
                "name": "Local ledger",
                "provider": "openai",
                "model": "ledger",
                "base_url": f"http://127.0.0.1:{receiver.server_port}/v1",
                "allow_private_network": True,
            },
            "workspace",
        )
        plugin_overflow = [
            run("chat", "plugin-overflow", isolated_ledger),
            run("schedule", "plugin-overflow-scheduled", isolated_ledger),
        ]
        assert all(
            result["status"] == "failed"
            and result["error_code"] == "tool_catalog_plugin_limit"
            and result["tool_results"] == 0
            for result in plugin_overflow
        ), plugin_overflow
        assert requests == [], requests
        print(
            json.dumps(
                {
                    "basic": out,
                    "boundary": boundary,
                    "overflow": overflow,
                    "plugin_boundary": exact,
                    "plugin_overflow": plugin_overflow,
                    "model_ledger_count": len(requests),
                },
                ensure_ascii=False,
                indent=2,
            ),
            flush=True,
        )
    finally:
        instance.stop()

receiver.shutdown()
receiver.server_close()
