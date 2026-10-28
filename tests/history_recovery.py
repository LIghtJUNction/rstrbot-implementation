#!/usr/bin/env python3
"""Restart a real SQLite core with more than 10,000 durable records per kind.

Synthetic historical receipts are inserted while the core is stopped. The test
then observes the public API and persisted database, including unfinished
records beyond the old scan limit. Explicit chats use a local diagnostic worker;
no commercial model or external destination is called.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import tempfile
import time
import traceback

from integration import Client, Instance, PASSWORD, ROOT, TERMINAL, wait_for


def exercise(binary, report):
    with tempfile.TemporaryDirectory(prefix="rstrbot-history-recovery-") as temporary:
        instance = Instance(Path(temporary) / "core", binary)
        try:
            instance.start()
            client = Client(instance.base)
            session = client.post("/api/v1/setup", {
                "token": (instance.directory / "bootstrap.token").read_text(),
                "username": "history-fixture", "password": PASSWORD, "workspace": "History",
            })
            user = session["user"]["id"]
            workspace = client.get("/api/v1/workspaces")["items"][0]["id"]
            base = f"/api/v1/workspaces/{workspace}"
            conversation = client.post(base + "/resources/conversations", {
                "visibility": "private", "data": {"title": "Recovery history"},
            })
            model = client.post(base + "/resources/models", {
                "visibility": "private", "data": {
                    "name": "Recovery diagnostic fixture", "provider": "diagnostic", "model": "diagnostic",
                },
            })
            original = client.post(base + '/chat', {'conversation_id': conversation['id'], 'model_id': model['id'],
                                   'content': 'history-before-restart', 'idempotency_key': 'history-before-restart'})
            previous = wait_for(lambda: client.get(base + '/runs/' + original['run']['id']),
                                lambda item: item['data']['status'] in TERMINAL)
            assert previous['data']['status'] == 'completed'
            wait_for(lambda: client.get(base + '/resource/' + conversation['id']),
                     lambda item: not item['data'].get('active_run'))
            before_messages = client.get(base + '/conversations/' + conversation['id'] + '/messages')['items']
            assert any(message.get('content') == 'history-before-restart' for message in before_messages)
            schedule_template = client.post(base + "/resources/schedules", {
                "visibility": "private", "data": {
                    "title": "Valid paused task", "prompt": "must not redispatch",
                    "model_id": model["id"], "conversation_id": conversation["id"],
                    "schedule_type": "once", "at": int(time.time()) + 3600, "enabled": False,
                },
            })
            instance.stop()
            timestamp = int(time.time())
            historical_count = 10_025
            query = "INSERT INTO resources (id,workspace_id,owner_id,kind,visibility,version,data,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)"

            def row(kind, identifier, data):
                return (identifier, workspace, user, kind, "private", json.dumps(data), timestamp, timestamp)

            with sqlite3.connect(instance.directory / "rstrbot.db") as database:
                for kind in ("runs", "deliveries", "schedules"):
                    data = {"status": "completed", "enabled": False}
                    if kind == "runs":
                        data.update(conversation_id=conversation["id"], generation=0, content="history")
                    elif kind == "schedules":
                        data = dict(schedule_template["data"], status="completed", enabled=False)
                    database.executemany(query, (row(kind, f"history-{kind}-{index:05d}", data)
                                                for index in range(historical_count)))
                pending_run = "zz-recovery-pending-run"
                database.execute(query, row("runs", pending_run, {
                    "status": "running", "conversation_id": conversation["id"],
                    "generation": 0, "content": "partial", "cost_microusd": None,
                }))
                database.execute(query, row("deliveries", "zz-recovery-sending", {"status": "sending"}))
                database.execute(query, row("deliveries", "zz-recovery-prepared", {"status": "prepared"}))
                pending_schedule = dict(schedule_template["data"], status="dispatching", enabled=True,
                                        claim_id="existing-intention", claimed_at=timestamp,
                                        scheduled_for=timestamp, run_id=None)
                database.execute(query, row("schedules", "zz-recovery-claimed", pending_schedule))
                current = json.loads(database.execute("SELECT data FROM resources WHERE id=?", (conversation["id"],)).fetchone()[0])
                current["active_run"] = pending_run
                database.execute("UPDATE resources SET data=? WHERE id=?", (json.dumps(current), conversation["id"]))
                operations_before = database.execute("SELECT COUNT(*) FROM operations").fetchone()[0]
            report["records_per_kind"] = historical_count
            report["checks"].append("over 10,000 historical runs, deliveries and schedules seeded with tied creation timestamps while the core is stopped")
            started = time.monotonic()
            instance.start()
            report["restart_seconds"] = round(time.monotonic() - started, 3)
            recovered = client.get(base + "/runs/" + pending_run)
            assert recovered["data"]["status"] == "interrupted", recovered
            assert recovered["data"]["cost_microusd"] is None, recovered
            assert not client.get(base + "/resource/" + conversation["id"])["data"].get("active_run")
            assert client.get(base + "/resource/zz-recovery-sending")["data"]["status"] == "unknown"
            assert client.get(base + "/resource/zz-recovery-prepared")["data"]["status"] == "not_sent"
            report["checks"].append("restart scans beyond the old limit, interrupts the pending run, clears its active lease and preserves uncertain delivery outcomes")
            schedule = wait_for(lambda: client.get(base + "/resource/zz-recovery-claimed"),
                                lambda item: item["data"]["status"] == "needs_reconciliation")
            assert schedule["data"]["enabled"] is False
            assert schedule["data"]["claim_id"] == "existing-intention"
            assert schedule["data"]["model_id"] == model["id"]
            assert schedule["data"]["conversation_id"] == conversation["id"]
            with sqlite3.connect(instance.directory / "rstrbot.db") as database:
                assert database.execute("SELECT COUNT(*) FROM operations").fetchone()[0] == operations_before
                assert database.execute("SELECT COUNT(*) FROM resources WHERE kind='runs'").fetchone()[0] == historical_count + 2
                for kind in ("runs", "deliveries", "schedules"):
                    count = database.execute("SELECT COUNT(*) FROM resources WHERE kind=? AND id LIKE 'history-%'", (kind,)).fetchone()[0]
                    assert count == historical_count, (kind, count)
            report["checks"].append("valid in-flight schedules beyond the old limit retain their original claim and parameters; all history remains and no new operation or run is admitted")
            assert client.get(base + '/conversations/' + conversation['id'] + '/messages')['items'] == before_messages
            resumed = client.post(base + '/chat', {'conversation_id': conversation['id'], 'model_id': model['id'],
                                  'content': 'history-after-restart', 'idempotency_key': 'history-after-restart'})
            fresh = wait_for(lambda: client.get(base + '/runs/' + resumed['run']['id']),
                             lambda item: item['data']['status'] in TERMINAL)
            assert fresh['data']['status'] == 'completed'
            messages = client.get(base + '/conversations/' + conversation['id'] + '/messages')['items']
            assert all(message in messages for message in before_messages)
            assert sum(message.get('content') == 'history-after-restart' for message in messages) == 1
            assert client.get(base + '/runs/' + pending_run)['data']['status'] == 'interrupted'
            with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                assert database.execute('SELECT COUNT(*) FROM operations').fetchone()[0] == operations_before + 1
            report['checks'].append('same conversation retains prior messages and accepts one explicit new diagnostic run after recovery without replaying the interrupted run')
        finally:
            instance.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/rstrbot")
    parser.add_argument("--output", type=Path)
    options = parser.parse_args()
    binary = options.binary.resolve()
    report = {
        "status": "running", "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "platform": platform.platform(), "database": "sqlite", "checks": [],
        "scope": "real SQLite restart with synthetic receipts and explicit local diagnostic calls; no commercial model or destination calls",
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "binary_sha256": {name: hashlib.sha256((binary.parent / name).read_bytes()).hexdigest()
                          for name in ("rstrbot", "rstrbot-openai", "rstrbot-diagnostic", "rstrbot-webhook")},
    }
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
