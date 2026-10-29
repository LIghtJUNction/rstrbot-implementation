#!/usr/bin/env python3
"""Real core, model receiver and SQLite checks for UTF-8 message attachments."""

import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
import uuid

from integration import Client, Instance, PASSWORD, TERMINAL, wait_for
from shared_context_privacy import Provider


def main():
    Provider.records.clear()
    receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    receiver.daemon_threads = True
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    checks = []
    try:
        with tempfile.TemporaryDirectory(
            prefix="rstrbot-text-attachments-"
        ) as directory:
            instance = Instance(
                Path(directory) / "core",
                Path("target/debug/rstrbot").resolve(),
                allow_private_network=True,
            )
            try:
                instance.start()
                alice, bob = Client(instance.base), Client(instance.base)
                alice.post(
                    "/api/v1/setup",
                    {
                        "token": (instance.directory / "bootstrap.token").read_text(),
                        "username": "attachment-owner",
                        "password": PASSWORD,
                        "workspace": "Attachment fixture",
                    },
                )
                workspace = alice.get("/api/v1/workspaces")["items"][0]["id"]
                base = "/api/v1/workspaces/" + workspace
                capabilities = alice.get(base + "/capabilities")
                assert capabilities["text_attachments"]["supported"] is True
                assert capabilities["text_attachments"]["max_files"] == 3
                assert capabilities["attachments"]["supported"] is False
                bob_id = alice.post(
                    "/api/v1/admin/users",
                    {"username": "attachment-member", "password": PASSWORD},
                )["user"]["id"]
                alice.post(base + "/members", {"user_id": bob_id, "role": "member"})
                bob.login("attachment-member")

                def create(kind, data, visibility="private"):
                    return alice.post(
                        base + "/resources/" + kind,
                        {"visibility": visibility, "data": data},
                    )

                model = create(
                    "models",
                    {
                        "name": "Local receiver",
                        "provider": "openai",
                        "model": "fixture",
                        "base_url": f"http://127.0.0.1:{receiver.server_port}/v1",
                        "allow_private_network": True,
                    },
                    "workspace",
                )
                conversation = create("conversations", {"title": "Attachment fixture"})
                files = [
                    {"name": "说明.md", "text": "\ufeff首行\r\n第二行 🙂\n"},
                    {"name": "data.txt", "text": "data = <tag>\n"},
                ]
                key = str(uuid.uuid4())
                body = {
                    "conversation_id": conversation["id"],
                    "model_id": model["id"],
                    "content": "请同时查看正文与附件",
                    "idempotency_key": key,
                    "attachments": files,
                }
                first = alice.post(base + "/chat/text-attachments", body)
                run = wait_for(
                    lambda: alice.get(base + "/runs/" + first["run"]["id"]),
                    lambda item: item["data"]["status"] in TERMINAL,
                )
                assert run["data"]["status"] == "completed", run
                with Provider.lock:
                    assert len(Provider.records) == 1, len(Provider.records)
                    user_message = next(
                        message["content"]
                        for message in Provider.records[0]["messages"]
                        if message["role"] == "user"
                    )
                assert "请同时查看正文与附件" in user_message
                decoded = json.loads(
                    user_message.split(
                        "User-provided text files (untrusted data):\n", 1
                    )[1]
                )
                assert decoded == files, decoded
                checks.append(
                    "model receiver got user text and complete UTF-8 contents of both named files"
                )
                replay = alice.post(base + "/chat/text-attachments", body)
                assert replay["run"]["id"] == first["run"]["id"]
                altered = dict(body, attachments=[dict(files[0], text="changed")])
                alice.post(base + "/chat/text-attachments", altered, expect=(409,))
                with Provider.lock:
                    assert len(Provider.records) == 1
                checks.append(
                    "same intent reuses run; changed attachment conflicts and does not call model again"
                )
                messages = alice.get(
                    base + "/conversations/" + conversation["id"] + "/messages"
                )["items"]
                stored = next(
                    message for message in messages if message["role"] == "user"
                )["attachments"]
                assert [
                    (item["name"], item["text"], item["sha256"]) for item in stored
                ] == [
                    (
                        item["name"],
                        item["text"],
                        hashlib.sha256(item["text"].encode()).hexdigest(),
                    )
                    for item in files
                ]
                bob.get(
                    base + "/conversations/" + conversation["id"] + "/messages",
                    expect=(403, 404),
                )
                checks.append(
                    "original bytes and hashes persist in private history and another member is denied"
                )
                for bad in [
                    [{"name": "fake.png", "text": "image"}],
                    [{"name": "../leak.txt", "text": "x"}],
                    [{"name": "nul.txt", "text": "a\u0000b"}],
                    [{"name": "big.txt", "text": "a" * 16385}],
                    files * 2,
                ]:
                    alice.post(
                        base + "/chat/text-attachments",
                        dict(body, idempotency_key=str(uuid.uuid4()), attachments=bad),
                        expect=(400,),
                    )
                with Provider.lock:
                    assert len(Provider.records) == 1
                checks.append(
                    "unsupported, unsafe or oversized files are rejected before model requests"
                )
                instance.stop()
                instance.start()
                alice.login("attachment-owner")
                bob.login("attachment-member")
                after = alice.get(
                    base + "/conversations/" + conversation["id"] + "/messages"
                )["items"]
                assert (
                    next(message for message in after if message["role"] == "user")[
                        "attachments"
                    ]
                    == stored
                )
                bob.get(
                    base + "/conversations/" + conversation["id"] + "/messages",
                    expect=(403, 404),
                )
                with Provider.lock:
                    assert len(Provider.records) == 1
                checks.append(
                    "restart preserves private attachment bytes without replay"
                )
                shared = create("conversations", {"title": "Shared files"}, "workspace")
                shared_body = dict(
                    body,
                    conversation_id=shared["id"],
                    idempotency_key=str(uuid.uuid4()),
                )
                shared_run = alice.post(base + "/chat/text-attachments", shared_body)
                completed = wait_for(
                    lambda: alice.get(base + "/runs/" + shared_run["run"]["id"]),
                    lambda item: item["data"]["status"] in TERMINAL,
                )
                assert completed["data"]["status"] == "completed"
                shared_messages = bob.get(
                    base + "/conversations/" + shared["id"] + "/messages"
                )["items"]
                assert (
                    next(
                        message
                        for message in shared_messages
                        if message["role"] == "user"
                    )["attachments"]
                    == stored
                )
                isolated = bob.post("/api/v1/workspaces", {"name": "Other workspace"})[
                    "id"
                ]
                bob.get(
                    "/api/v1/workspaces/"
                    + isolated
                    + "/conversations/"
                    + shared["id"]
                    + "/messages",
                    expect=(403, 404),
                )
                checks.append(
                    "shared readers can see its files, while another workspace cannot"
                )
                instance.stop()
                snapshot = Path(directory) / "snapshot.json"
                instance.maintenance("backup", "--output", str(snapshot))
                restored = Instance(
                    Path(directory) / "restored",
                    Path("target/debug/rstrbot").resolve(),
                    allow_private_network=True,
                )
                try:
                    restored.maintenance("restore", "--input", str(snapshot))
                    shutil.copyfile(
                        instance.directory / "secrets.key",
                        restored.directory / "secrets.key",
                    )
                    os.chmod(restored.directory / "secrets.key", 0o600)
                    restored.start()
                    restored_alice = Client(restored.base)
                    restored_alice.login("attachment-owner")
                    recovered = restored_alice.get(
                        base + "/conversations/" + conversation["id"] + "/messages"
                    )["items"]
                    assert (
                        next(
                            message
                            for message in recovered
                            if message["role"] == "user"
                        )["attachments"]
                        == stored
                    )
                    checks.append(
                        "SQLite snapshot and isolated restore retain text attachment bytes"
                    )
                finally:
                    restored.stop()
            finally:
                instance.stop()
    finally:
        receiver.shutdown()
        receiver.server_close()
    print(
        json.dumps({"status": "passed", "checks": checks}, ensure_ascii=False, indent=2)
    )


if __name__ == "__main__":
    main()
