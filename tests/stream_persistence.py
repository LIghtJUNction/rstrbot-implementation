#!/usr/bin/env python3
"""Verify exact durable SSE fragments while authorization shares SQLite's pool.

The upstream is a loopback protocol fixture, not a commercial model. Three
simultaneous runs overlap multiple authorization ticks and retain every fragment.
"""
import argparse
import datetime
import hashlib
import http.server
import json
from pathlib import Path
import platform
import sqlite3
import tempfile
import threading
import time
import traceback
import uuid

from integration import Client, Instance, PASSWORD, ROOT, TERMINAL, wait_for


class Provider(http.server.BaseHTTPRequestHandler):
    requests = 0
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        label = request["messages"][-1]["content"]
        with self.lock:
            type(self).requests += 1
        chunks = []
        for index in range(50):
            chunk = {"id": label, "model": "stream-fixture", "choices": [{"index": 0,
                     "delta": {"content": f"{label}:{index:02d}|"}, "finish_reason": None}]}
            chunks.append(("data: " + json.dumps(chunk) + "\n\n").encode())
        final = {"id": label, "model": "stream-fixture", "choices": [{"index": 0, "delta": {},
                 "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 50}}
        chunks.append(("data: " + json.dumps(final) + "\n\ndata: [DONE]\n\n").encode())
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(sum(map(len, chunks))))
        self.end_headers()
        try:
            for chunk in chunks:
                self.wfile.write(chunk)
                self.wfile.flush()
                time.sleep(0.01)
        except (BrokenPipeError, ConnectionResetError):
            pass


def exercise(binary, report):
    receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    receiver.daemon_threads = True
    thread = threading.Thread(target=receiver.serve_forever, daemon=True)
    thread.start()
    instance = None
    try:
        with tempfile.TemporaryDirectory(prefix="rstrbot-stream-persistence-") as temporary:
            instance = Instance(Path(temporary) / "core", binary, None, allow_private_network=True)
            instance.start()
            client = Client(instance.base)
            client.post("/api/v1/setup", {"token": (instance.directory / "bootstrap.token").read_text(),
                        "username": "stream-fixture", "password": PASSWORD, "workspace": "Streaming"})
            workspace = client.get("/api/v1/workspaces")["items"][0]["id"]
            base = f"/api/v1/workspaces/{workspace}"
            model = client.post(base + "/resources/models", {"visibility": "private", "data": {
                "name": "Local SSE fixture (not AI)", "provider": "openai", "model": "stream-fixture",
                "base_url": f"http://127.0.0.1:{receiver.server_port}/v1", "allow_private_network": True}})
            runs = []
            for index in range(3):
                label = f"stream-{index}"
                conversation = client.post(base + "/resources/conversations", {
                    "visibility": "private", "data": {"title": label}})
                key = str(uuid.uuid4())
                admitted = client.post(base + "/chat", {"conversation_id": conversation["id"],
                    "model_id": model["id"], "content": label, "idempotency_key": key})
                runs.append((label, conversation["id"], admitted["run"]["id"], key))
            completed = []
            for label, conversation, run_id, _key in runs:
                run = wait_for(lambda: client.get(base + "/runs/" + run_id),
                               lambda value: value["data"]["status"] in TERMINAL)
                expected = "".join(f"{label}:{index:02d}|" for index in range(50))
                assert run["data"]["status"] == "completed", run
                assert run["data"]["content"] == expected, run
                calls = run["data"]["model_calls"]
                assert len(calls) == 1 and calls[0]["stream_persistence"] == "saved", run
                assert calls[0]["usage"]["completion_tokens"] == 50, run
                wait_for(lambda: client.get(base + "/resource/" + conversation),
                         lambda value: not value["data"].get("active_run"))
                completed.append((run_id, expected))
            report["checks"].append("three simultaneous SQLite runs preserve final content and known usage while authorization ticks share the pool")
            events = client.get(base + "/events?limit=500")["items"]
            for run_id, expected in completed:
                fragments = [event["data"]["delta"] for event in events
                             if event["kind"] == "run.delta" and event["data"].get("run_id") == run_id]
                assert len(fragments) == 50 and "".join(fragments) == expected, {"run_id": run_id, "fragments": fragments}
            report["checks"].append("all 150 actual HTTP/SSE fragments are durably replayed in order without loss or duplication")
            instance.stop()
            instance.start()
            assert client.get(base + "/events?limit=500")["items"] == events
            for run_id, expected in completed:
                assert client.get(base + "/runs/" + run_id)["data"]["content"] == expected
            with Provider.lock:
                assert Provider.requests == 3, Provider.requests
            report["checks"].append("core restart preserves identical durable fragments and final receipts without another provider request")

            label, conversation_id, _run_id, key = runs[0]
            runs_before_conflict = {run["id"] for run in client.get(base + "/resources/runs")["items"]}
            messages_before_conflict = client.get(base + f"/conversations/{conversation_id}/messages")
            events_before_conflict = client.get(base + "/events?limit=500")["items"]
            client.post(base + "/chat", {"conversation_id": conversation_id,
                        "model_id": model["id"], "content": label + ":changed",
                        "idempotency_key": key}, expect=(409,))
            assert {run["id"] for run in client.get(base + "/resources/runs")["items"]} == runs_before_conflict
            assert client.get(base + f"/conversations/{conversation_id}/messages") == messages_before_conflict
            assert client.get(base + "/events?limit=500")["items"] == events_before_conflict
            with Provider.lock:
                assert Provider.requests == 3, Provider.requests
            report["checks"].append("after the accepted HTTP/SSE call, changed-body key conflict returns 409 with no new provider request, run, message or event")

            post_label = "post-response-conflict"
            post_conversation = client.post(base + "/resources/conversations", {
                "visibility": "private", "data": {"title": post_label}})
            marker = f"{post_label}:49|"
            trigger = "reject_final_assistant_" + uuid.uuid4().hex
            with sqlite3.connect(instance.directory / "rstrbot.db", timeout=5) as connection:
                connection.execute(f"""CREATE TRIGGER {trigger} BEFORE UPDATE ON resources
                    WHEN OLD.id = '{post_conversation["id"]}' AND instr(NEW.data, '{marker}') > 0
                    BEGIN SELECT RAISE(IGNORE); END""")
            post_body = {"conversation_id": post_conversation["id"], "model_id": model["id"],
                         "content": post_label, "idempotency_key": str(uuid.uuid4())}
            with Provider.lock:
                provider_requests_before_response = Provider.requests
                assert provider_requests_before_response == 3, provider_requests_before_response
            post_admitted = client.post(base + "/chat", post_body)
            post_run_id = post_admitted["run"]["id"]
            failed = wait_for(lambda: client.get(base + "/runs/" + post_run_id),
                              lambda value: value["data"]["status"] in TERMINAL)
            assert failed["data"]["status"] == "failed", failed
            assert failed["data"]["error_code"] == "conflict", failed
            assert failed["data"]["content"] == "", failed
            assert len(failed["data"]["model_calls"]) == 1
            assert failed["data"]["model_calls"][0]["status"] == "completed"
            assert failed["data"]["model_calls"][0]["stream_persistence"] == "saved"
            assert failed["data"]["model_calls"][0]["usage"]["completion_tokens"] == 50
            messages_after_conflict = client.get(base + f"/conversations/{post_conversation['id']}/messages")
            assert [item["role"] for item in messages_after_conflict["items"]] == ["user"]
            with Provider.lock:
                provider_requests_after_response = Provider.requests
                assert provider_requests_after_response == provider_requests_before_response + 1
                assert provider_requests_after_response == 4, provider_requests_after_response

            run_ids_after_conflict = {run["id"] for run in client.get(base + "/resources/runs")["items"]}
            events_after_conflict = wait_for(
                lambda: client.get(base + "/events?limit=500")["items"],
                lambda items: any(event["kind"] == "run.finished"
                                  and event["data"]["run_id"] == post_run_id for event in items))
            finish_events = [event for event in events_after_conflict
                             if event["kind"] == "run.finished" and event["data"]["run_id"] == post_run_id]
            assert len(finish_events) == 1 and finish_events[0]["data"]["error_code"] == "conflict"
            conflict_deltas = [event["data"]["delta"] for event in events_after_conflict
                               if event["kind"] == "run.delta" and event["data"]["run_id"] == post_run_id]
            expected_conflict_stream = "".join(f"{post_label}:{index:02d}|" for index in range(50))
            assert len(conflict_deltas) == 50 and "".join(conflict_deltas) == expected_conflict_stream
            replayed = client.post(base + "/chat", post_body)
            assert replayed["run"]["id"] == post_run_id
            client.post(base + "/chat", {**post_body, "content": post_label + ":changed"}, expect=(409,))
            assert {run["id"] for run in client.get(base + "/resources/runs")["items"]} == run_ids_after_conflict
            assert client.get(base + f"/conversations/{post_conversation['id']}/messages") == messages_after_conflict
            assert client.get(base + "/events?limit=500")["items"] == events_after_conflict
            with Provider.lock:
                provider_requests_after_replays = Provider.requests
                assert provider_requests_after_replays == provider_requests_after_response
            report["post_response_conflict"] = {
                "injected_by": "SQLite trigger makes assistant append CAS affect zero rows",
                "run_status": failed["data"]["status"],
                "run_error_code": failed["data"]["error_code"],
                "model_call_status": failed["data"]["model_calls"][0]["status"],
                "stream_persistence": failed["data"]["model_calls"][0]["stream_persistence"],
                "completion_tokens": failed["data"]["model_calls"][0]["usage"]["completion_tokens"],
                "conversation_message_roles": [item["role"] for item in messages_after_conflict["items"]],
                "persisted_delta_count": len(conflict_deltas),
                "provider_requests_after_response": provider_requests_after_response,
                "provider_requests_before_response": provider_requests_before_response,
                "provider_requests_after_replays": provider_requests_after_replays,
                "exact_key_replay_returned_original_run": replayed["run"]["id"] == post_run_id,
                "changed_body_same_key_status": 409,
                "run_finished_conflict_event_count": len(finish_events),
            }
            report["checks"].append("post-response assistant-message CAS conflict fails the run without replay; model call stays completed once, history is unchanged, and exact/conflicting keys dispatch no further request")
    finally:
        if instance:
            instance.stop()
        receiver.shutdown()
        receiver.server_close()
        thread.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/rstrbot")
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    binary = options.binary.resolve()
    report = {"status": "running", "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "platform": platform.platform(), "database": "sqlite", "checks": [],
              "scope": "actual local HTTP/SSE worker with synthetic fragments, not a commercial model",
              "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "binary_sha256": {name: hashlib.sha256((binary.parent / name).read_bytes()).hexdigest()
                                for name in ("rstrbot", "rstrbot-openai", "rstrbot-diagnostic", "rstrbot-webhook")}}
    started = time.monotonic()
    try:
        exercise(binary, report)
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", error=str(error), traceback=traceback.format_exc())
    report["duration_seconds"] = round(time.monotonic() - started, 3)
    report["passed_checks"] = len(report["checks"])
    encoded = json.dumps(report, indent=2) + "\n"
    if options.output:
        options.output.parent.mkdir(parents=True, exist_ok=True)
        options.output.write_text(encoded)
    print(encoded, end="")
    return int(report["status"] != "passed")


if __name__ == "__main__":
    raise SystemExit(main())
