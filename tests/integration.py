#!/usr/bin/env python3
"""Black-box acceptance against real binaries, HTTP cookies, files and databases.

The model is the explicitly labeled diagnostic process fixture; these tests do
not claim validation against a commercial model or a live messaging platform.
PostgreSQL uses a new disposable schema, never the URL's existing tables.
"""
import argparse
import contextlib
import datetime
import hashlib
import http.cookiejar
import json
import os
import platform
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "RstrBot integration password 2026!"
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


class Client:
    def __init__(self, base):
        self.base = base
        self.cookies = http.cookiejar.CookieJar()
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies), urllib.request.ProxyHandler({}))

    def request(self, method, path, data=None, expect=(200,), browser=True, extra=None):
        headers = {"Accept": "application/json"}
        if browser:
            headers.update({"Origin": self.base, "X-RstrBot-Request": "1"})
        if data is not None:
            headers["Content-Type"] = "application/json"
        if extra:
            headers.update(extra)
        request = urllib.request.Request(self.base + path, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
        try:
            response = self.http.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            status = response.status
            result = json.loads(body) if body and "application/json" in response.headers.get("Content-Type", "") else body.decode(errors="replace")
        assert status in expect, f"{method} {path}: expected {expect}, got {status}: {str(result)[:800]}"
        return result

    def get(self, path, **kwargs):
        return self.request("GET", path, **kwargs)

    def post(self, path, data=None, **kwargs):
        return self.request("POST", path, data, **kwargs)

    def login(self, username):
        result = self.post("/api/v1/auth/login", {"username": username, "password": PASSWORD})
        assert "token" not in result, "Browser login must use an HttpOnly cookie, not a JSON bearer token"
        assert any(cookie.name == "rstrbot_session" for cookie in self.cookies)
        return result["user"]


class Database:
    def __init__(self, base_url):
        self.base_url = base_url
        self.schemas = []

    def fresh(self):
        if not self.base_url:
            return None
        psql = os.environ.get("RSTRBOT_PSQL") or shutil.which("psql")
        if not psql:
            raise RuntimeError("PostgreSQL HTTP tests require psql to create isolated disposable schemas")
        schema = "rstrbot_http_" + uuid.uuid4().hex
        subprocess.run([psql, self.base_url, "-X", "-v", "ON_ERROR_STOP=1", "-qc", f"CREATE SCHEMA {schema}"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.schemas.append(schema)
        url = urllib.parse.urlsplit(self.base_url)
        query = urllib.parse.parse_qsl(url.query)
        if any(key == "options" for key, _ in query):
            raise RuntimeError("Use a test URL without existing options; this harness sets a private search_path")
        query.append(("options", "-csearch_path=" + schema))
        return urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query)))

    def cleanup(self):
        if not self.base_url:
            return
        psql = os.environ.get("RSTRBOT_PSQL") or shutil.which("psql")
        for schema in self.schemas:
            subprocess.run([psql, self.base_url, "-X", "-v", "ON_ERROR_STOP=1", "-qc", f"DROP SCHEMA {schema} CASCADE"], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class Instance:
    def __init__(self, directory, binary, database_url=None, valkey_url=None, allow_private_network=False):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.binary = binary
        self.environment = dict(os.environ)
        for key in ("RSTRBOT_DATABASE_URL", "RSTRBOT_DATA_DIR", "RSTRBOT_LISTEN", "RSTRBOT_SECURE_COOKIE", "RSTRBOT_VALKEY_URL", "RSTRBOT_ALLOW_PRIVATE_NETWORK"):
            self.environment.pop(key, None)
        if database_url:
            self.environment["RSTRBOT_DATABASE_URL"] = database_url
        if valkey_url:
            self.environment["RSTRBOT_VALKEY_URL"] = valkey_url
        if allow_private_network:
            self.environment["RSTRBOT_ALLOW_PRIVATE_NETWORK"] = "true"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.process = None
        self.log = None

    def command(self, *arguments):
        return [str(self.binary), "--data-dir", str(self.directory), *arguments]

    def start(self):
        self.log = (self.directory / "server-test.log").open("ab")
        self.process = subprocess.Popen(self.command("--listen", f"127.0.0.1:{self.port}", "--web-dir", str(ROOT / "web/dist")), env=self.environment, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=os.name != "nt")
        deadline = time.monotonic() + 30
        client = Client(self.base)
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise AssertionError("Server exited during startup: " + (self.directory / "server-test.log").read_text(errors="replace")[-2500:])
            try:
                client.get("/api/v1/setup")
                return
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.05)
        raise AssertionError("Server did not become ready")

    def stop(self, crash=False):
        if self.process and self.process.poll() is None:
            descendants = []
            if crash and Path("/proc").is_dir():
                parent_ids = {self.process.pid}
                for _ in range(6):
                    added = set()
                    for item in Path("/proc").iterdir():
                        if not item.name.isdigit():
                            continue
                        try:
                            fields = (item / "stat").read_text().rsplit(")", 1)[1].split()
                            if int(fields[1]) in parent_ids:
                                added.add(int(item.name))
                        except (OSError, ValueError, IndexError):
                            continue
                    if added <= parent_ids:
                        break
                    parent_ids.update(added)
                descendants = list(parent_ids - {self.process.pid})
            if crash:
                self.process.kill()
            else:
                self.process.terminate()
            self.process.wait(timeout=20)
            # A SIGKILL cannot run the core's destructors. This harness cleans
            # only its captured descendants and does not claim crash-time OS
            # process-tree guarantees from this cleanup.
            for pid in descendants:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGKILL)
        if self.log:
            self.log.close()
            self.log = None

    def maintenance(self, *arguments):
        result = subprocess.run(self.command(*arguments), env=self.environment, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, f"Maintenance failed: {result.stderr}"
        return result.stdout


def wait_for(function, predicate, timeout=20):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = function()
        if predicate(last):
            return last
        time.sleep(0.08)
    raise AssertionError("Timed out waiting for state: " + str(last)[:800])


@contextlib.contextmanager
def fixture_directory(database, keep_on_failure, report):
    directory = tempfile.mkdtemp(prefix="rstrbot-http-")
    completed = False
    try:
        yield directory
        completed = True
    finally:
        if keep_on_failure and not completed:
            # Retain only this harness's disposable data and schema names. Do
            # not copy connection URLs (which may contain credentials) into
            # the public evidence document.
            report["retained_fixture_directory"] = directory
            report["retained_database_schemas"] = database.schemas
        else:
            database.cleanup()
            shutil.rmtree(directory)


def exercise(options, report):
    database = Database(options.database_url)
    instances = []
    with fixture_directory(database, options.keep_on_failure, report) as directory:
        try:
            server = Instance(Path(directory) / "original", options.binary, database.fresh(), options.valkey_url)
            instances.append(server)
            server.start()
            alice, bob = Client(server.base), Client(server.base)
            assert alice.get("/api/v1/openapi.json")==json.loads((ROOT/"docs/openapi.json").read_text())
            proof = (server.directory / "bootstrap.token").read_text()
            foreign_file = server.directory / "unrelated.sqlite"
            with sqlite3.connect(foreign_file) as connection:
                connection.execute("CREATE TABLE sentinel (value TEXT NOT NULL)")
                connection.execute("INSERT INTO sentinel VALUES ('must not change')")
            before_probe = hashlib.sha256(foreign_file.read_bytes()).hexdigest()
            probe = alice.post("/api/v1/setup/test-database", {"token":proof,"database_url":f"sqlite://{foreign_file}?mode=ro"})
            assert probe["read_only_probe"] is True and probe["can_select"] is False
            alice.post("/api/v1/setup/database", {"token":proof,"database_url":f"sqlite://{foreign_file}?mode=rw"},expect=(409,))
            assert hashlib.sha256(foreign_file.read_bytes()).hexdigest() == before_probe
            with sqlite3.connect(foreign_file) as connection:
                assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [("sentinel",)]
            report["checks"].append("setup database connectivity probe is read-only and never migrates an unrelated SQLite database")
            if options.expected_cache_state:
                cache = wait_for(lambda:alice.get("/api/v1/setup"),lambda value:value.get("valkey_status")==options.expected_cache_state,timeout=12)
                report["valkey_observed"] = cache["valkey_status"]
                report["checks"].append(f"optional Valkey reports its actual {options.expected_cache_state} state")
            alice.post("/api/v1/setup", {"token":"wrong", "username":"alice", "password":PASSWORD, "workspace":"Workspace"}, expect=(403,))
            session = alice.post("/api/v1/setup", {"token":proof, "username":"alice", "password":PASSWORD, "workspace":"Workspace"})
            assert "token" not in session
            alice.post("/api/v1/setup", {"token":proof, "username":"other", "password":PASSWORD, "workspace":"Takeover"}, expect=(409,))
            alice.post("/api/v1/workspaces", {"name":"Bad CSRF"}, browser=False, expect=(403,))
            alice.post("/api/v1/workspaces", {"name":"Bad origin"}, extra={"Origin":"https://untrusted.example"}, expect=(403,))
            report["checks"].append("served OpenAPI matches the shipped contract; one-time setup proof, HttpOnly-cookie session and CSRF/origin rejection")
            workspace = alice.get("/api/v1/workspaces")["items"][0]["id"]
            base = f"/api/v1/workspaces/{workspace}"
            bob_user = alice.post("/api/v1/admin/users", {"username":"bob", "password":PASSWORD})["user"]
            bob.login("bob")
            bob_workspace = bob.post("/api/v1/workspaces", {"name":"Workspace"})["id"]
            alice.post(base + "/members", {"user_id":bob_user["id"], "role":"member"})

            def create(client, kind, data, visibility="private"):
                return client.post(base + "/resources/" + kind, {"visibility":visibility, "data":data})

            def resource(client, item):
                return client.get(base + "/resource/" + item["id"])

            def send(client, conversation, model, content, key=None):
                body = {"conversation_id":conversation["id"], "model_id":model["id"], "content":content, "idempotency_key":key or str(uuid.uuid4())}
                return client.post(base + "/chat", body), body

            def terminal(client, run):
                return wait_for(lambda:client.get(base + "/runs/" + run["id"]), lambda r:r["data"]["status"] in TERMINAL)

            alice_private = create(alice,"conversations",{"title":"Alice private sentinel"})
            bob_private = create(bob,"conversations",{"title":"Bob private sentinel"})
            alice.get(base + "/resource/" + bob_private["id"],expect=(404,))
            bob.get(base + "/resource/" + alice_private["id"],expect=(404,))
            bob.get(f"/api/v1/workspaces/{bob_workspace}/resource/{alice_private['id']}",expect=(404,))
            assert "Bob private sentinel" not in json.dumps(alice.get(base + "/export"))
            assert bob_private["id"] not in json.dumps(alice.get(base + "/events"))
            report["checks"].append("two-user, cross-workspace and same-workspace private isolation across read/export/events")

            model = create(alice,"models",{"name":"Diagnostic fixture", "provider":"diagnostic", "model":"diagnostic", "max_tokens":1024},"workspace")
            plugin = create(alice,"plugins",{"name":"Diagnostic tools", "package_id":"diagnostic", "enabled":True, "config":{}},"workspace")
            assert alice.post(base + f"/models/{model['id']}/test",{})["fixture"] is True
            started, body = send(bob,bob_private,model,"/diagnostic/tool tool-roundtrip-sentinel")
            done = terminal(bob,started["run"])
            assert done["data"]["status"] == "completed",done
            assert "tool-roundtrip-sentinel" in done["data"]["content"] and "Tool result received" in done["data"]["content"], done
            before = bob.get(base + f"/conversations/{bob_private['id']}/messages")
            protocol_calls = {
                call["id"]
                for message in before["items"]
                for call in message.get("tool_calls", [])
            }
            protocol_results = {
                message["tool_call_id"]
                for message in before["items"]
                if message["role"] == "tool"
            }
            assert protocol_calls and protocol_calls == protocol_results, "Every tool call must have a matching durable result"
            stream_events = bob.get(base + "/events?limit=500")["items"]
            assert any(event["kind"] == "run.delta" and event["data"].get("run_id") == done["id"] and event["data"].get("delta") for event in stream_events), {"missing_delta_for_run":done["id"],"run":done,"events":stream_events}
            replay = bob.post(base + "/chat",body)
            assert replay["run"]["id"] == done["id"], replay
            after = bob.get(base + f"/conversations/{bob_private['id']}/messages")
            assert before == after, {"messages_before_retry":before,"messages_after_retry":after}
            body["content"] = "changed intention"
            runs_before_conflict = {run["id"] for run in bob.get(base + "/resources/runs")["items"]}
            messages_before_conflict = bob.get(base + f"/conversations/{bob_private['id']}/messages")
            events_before_conflict = bob.get(base + "/events?limit=500")["items"]
            bob.post(base + "/chat",body,expect=(409,))
            runs_after_conflict = {run["id"] for run in bob.get(base + "/resources/runs")["items"]}
            messages_after_conflict = bob.get(base + f"/conversations/{bob_private['id']}/messages")
            events_after_conflict = bob.get(base + "/events?limit=500")["items"]
            assert runs_after_conflict == runs_before_conflict, {
                "runs_before_conflict":runs_before_conflict,
                "runs_after_conflict":runs_after_conflict,
            }
            assert messages_after_conflict == messages_before_conflict, {
                "messages_before_conflict":messages_before_conflict,
                "messages_after_conflict":messages_after_conflict,
            }
            assert events_after_conflict == events_before_conflict, {
                "events_before_conflict":events_before_conflict,
                "events_after_conflict":events_after_conflict,
            }
            report["checks"].append("real provider/tool subprocess loop, stream events, persisted tool result and stable request idempotency")
            report["checks"].append("same idempotency key with changed body returns 409 without a second run, message mutation or event")

            in_flight, in_flight_body = send(bob,bob_private,model,"/diagnostic/wait")
            wait_for(lambda:bob.get(base + "/runs/" + in_flight["run"]["id"]),lambda r:r["data"]["stage"]=="model")
            assert bob.post(base + "/chat",in_flight_body)["run"]["id"] == in_flight["run"]["id"]
            deferred_body = {"conversation_id":bob_private["id"],"model_id":model["id"],"content":"retry-after-busy-sentinel","idempotency_key":str(uuid.uuid4())}
            bob.post(base + "/chat",deferred_body,expect=(409,))
            bob.post(base + f"/runs/{in_flight['run']['id']}/cancel",{},expect=(204,))
            assert terminal(bob,in_flight["run"])["data"]["status"] == "cancelled"
            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            deferred = bob.post(base + "/chat",deferred_body)
            assert terminal(bob,deferred["run"])["data"]["status"] == "completed"
            report["checks"].append("in-flight request retry keeps its run and a rejected busy request can later reuse its key")

            plain,_ = send(bob,bob_private,model,"Please write the word echo; this is plain text, not a protocol tool call")
            assert terminal(bob,plain["run"])["data"]["status"] == "completed"
            assert not any(event["kind"] == "run.tool" and event["data"].get("run_id") == plain["run"]["id"] for event in bob.get(base + "/events?limit=500")["items"])
            report["checks"].append("tool names in ordinary model text do not execute tools")

            started,_ = send(bob,bob_private,model,"/diagnostic/wait")
            bob.post(base + f"/runs/{started['run']['id']}/cancel",{},expect=(204,))
            assert terminal(bob,started["run"])["data"]["status"] == "cancelled"
            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            started,_ = send(bob,bob_private,model,"/diagnostic/wait")
            previous_generation = resource(bob,bob_private)["data"]["generation"]
            bob.post(base + f"/conversations/{bob_private['id']}/reset",{},expect=(204,))
            assert terminal(bob,started["run"])["data"]["status"] == "cancelled"
            assert resource(bob,bob_private)["data"]["generation"] == previous_generation + 1
            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            started,_ = send(bob,bob_private,model,"/diagnostic/wait")
            alice.request("DELETE",base + "/members/" + bob_user["id"],expect=(204,))
            bob.get(base + "/events",expect=(403,))
            bob.get(base + "/resource/" + bob_private["id"],expect=(404,))
            time.sleep(0.2)
            alice.post(base + "/members",{"user_id":bob_user["id"],"role":"member"})
            assert terminal(bob,started["run"])["data"]["status"] == "cancelled"
            report["checks"].append("cancellation, reset generations and current-membership revocation cancel owned running work")

            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            started,_ = send(bob,bob_private,model,"/diagnostic/wait")
            wait_for(lambda:bob.get(base + "/runs/" + started["run"]["id"]),lambda r:r["data"]["stage"]=="model")
            current_plugin = resource(alice,plugin)
            disabled_data = dict(current_plugin["data"],enabled=False)
            disabled = alice.request("PATCH",base + "/resource/" + plugin["id"],{"version":current_plugin["version"],"data":disabled_data})
            assert terminal(bob,started["run"])["data"]["status"] == "cancelled"
            alice.request("PATCH",base + "/resource/" + plugin["id"],{"version":current_plugin["version"],"data":disabled_data},expect=(409,))
            enabled_data = dict(disabled["data"],enabled=True)
            plugin = alice.request("PATCH",base + "/resource/" + plugin["id"],{"version":disabled["version"],"data":enabled_data})
            report["checks"].append("plugin disable revokes active capabilities and stale configuration cannot overwrite the new generation")

            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            started,_ = send(bob,bob_private,model,"/diagnostic/wait")
            wait_for(lambda:bob.get(base + "/runs/" + started["run"]["id"]),lambda r:r["data"]["stage"]=="model")
            current_model = resource(alice,model)
            model = alice.request("PATCH",base + "/resource/" + model["id"],{"version":current_model["version"],"data":dict(current_model["data"],max_tokens=512)})
            assert terminal(bob,started["run"])["data"]["status"] == "cancelled"
            wait_for(lambda:resource(bob,bob_private),lambda c:not c["data"].get("active_run"))
            report["checks"].append("changing a model configuration version revokes the running worker's old configuration lease")

            secret_doc = create(bob,"knowledge",{"title":"Private needle", "text":"needle hidden-document-sentinel", "enabled":True})
            create(alice,"knowledge",{"title":"Shared needle", "text":"needle shared-document-sentinel", "enabled":True},"workspace")
            owner_results = json.dumps(alice.get(base + "/knowledge/search?q=needle"))
            bob_results = json.dumps(bob.get(base + "/knowledge/search?q=needle"))
            assert "hidden-document-sentinel" not in owner_results and "shared-document-sentinel" in owner_results
            assert "hidden-document-sentinel" in bob_results
            bob.request("DELETE",base + f"/resource/{secret_doc['id']}?version={secret_doc['version']}",expect=(204,))
            assert "hidden-document-sentinel" not in json.dumps(bob.get(base + "/knowledge/search?q=needle"))
            report["checks"].append("real lexical indexing, references, private knowledge filtering and deletion from retrieval")

            scheduled_conversation = create(alice,"conversations",{"title":"Scheduled conversation"})
            schedule = create(alice,"schedules",{"title":"Once", "prompt":"scheduled-sentinel", "conversation_id":scheduled_conversation["id"], "model_id":model["id"], "schedule_type":"once", "at":int(time.time())+2,"enabled":True})
            finished_schedule = wait_for(lambda:resource(alice,schedule),lambda s:s["data"]["status"]=="completed",timeout=20)
            assert finished_schedule["data"].get("run_id")
            messages = alice.get(base + f"/conversations/{scheduled_conversation['id']}/messages")["items"]
            assert sum(message["role"]=="user" and message["content"]=="scheduled-sentinel" for message in messages)==1
            report["checks"].append("persisted one-time schedule actually dispatches once through the model worker")

            fake_secret = "rstrbot-artificial-secret-" + uuid.uuid4().hex
            secret_model = create(alice,"models",{"name":"Secret storage only", "provider":"openai", "model":"not-called", "base_url":"https://provider.invalid/v1", "api_key":fake_secret},"workspace")
            assert fake_secret not in json.dumps(secret_model) and secret_model["data"]["has_api_key"]
            snapshot = alice.get("/api/v1/admin/backup")
            assert fake_secret not in json.dumps(snapshot)
            if not options.database_url:
                for filename in ("rstrbot.db","rstrbot.db-wal"):
                    path = server.directory / filename
                    if path.exists():
                        assert fake_secret.encode() not in path.read_bytes()
            report["checks"].append("credential responses are redacted and database snapshot contains no plaintext provider secret")

            crashed_conversation = create(alice,"conversations",{"title":"Crash recovery"})
            started, crash_body = send(alice,crashed_conversation,model,"/diagnostic/wait")
            wait_for(lambda:alice.get(base + "/runs/" + started["run"]["id"]),lambda r:r["data"]["status"]=="running")
            server.stop(crash=True)
            server.start()
            interrupted = alice.get(base + "/runs/" + started["run"]["id"])
            assert interrupted["data"]["status"] == "interrupted"
            assert alice.post(base + "/chat",crash_body)["run"]["id"]==interrupted["id"]
            assert resource(alice,schedule)["data"]["run_id"]==finished_schedule["data"]["run_id"]
            assert len(alice.get(base + f"/conversations/{scheduled_conversation['id']}/messages")["items"])==len(messages)
            report["checks"].append("hard-killed core restarts with interrupted receipt and no run or schedule redispatch")

            bob_record = resource(bob,bob_private)
            bob.request("DELETE",base + f"/resource/{bob_private['id']}?version={bob_record['version']}",expect=(204,))
            bob.get(base + "/runs/" + done["id"],expect=(404,))
            assert "tool-roundtrip-sentinel" not in json.dumps(bob.get(base + "/events?limit=500"))
            report["checks"].append("conversation deletion cascades through run payloads and replayable event bodies")

            server.stop()
            backup_file = Path(directory) / "database-backup.json"
            server.maintenance("backup","--output",str(backup_file))
            backup = json.loads(backup_file.read_text())
            assert backup["includes_external_state"] is False and "sessions" not in backup["tables"]
            recovered = Instance(Path(directory) / "restored",options.binary,database.fresh(),options.valkey_url)
            instances.append(recovered)
            recovered.maintenance("restore","--input",str(backup_file))
            shutil.copyfile(server.directory / "secrets.key",recovered.directory / "secrets.key")
            os.chmod(recovered.directory / "secrets.key",0o600)
            recovered.start()
            restored = Client(recovered.base)
            restored.login("alice")
            restored.post(base + "/chat",{"conversation_id":alice_private["id"],"model_id":model["id"],"content":"must remain paused","idempotency_key":str(uuid.uuid4())},expect=(409,))
            assert restored.get(base + "/runs/" + interrupted["id"])["data"]["status"]=="interrupted"
            restored.post("/api/v1/admin/recovery/complete",{},expect=(204,))
            resumed,_ = send(restored,alice_private,model,"restored-sentinel")
            assert terminal(restored,resumed["run"])["data"]["status"]=="completed"
            report["checks"].append("CLI backup, empty-target restore, preserved identities/records, recovery quarantine and explicit resume")
        finally:
            for instance in reversed(instances):
                instance.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary",type=Path,default=ROOT / "target/debug/rstrbot")
    parser.add_argument("--database-url",default=os.environ.get("RSTRBOT_TEST_DATABASE_URL"))
    parser.add_argument("--valkey-url",default=os.environ.get("RSTRBOT_TEST_VALKEY_URL"))
    parser.add_argument("--expected-cache-state",choices=("available","degraded","disabled","invalid_configuration"))
    parser.add_argument("--keep-on-failure", action="store_true", help="Retain only this run's disposable data and schemas when debugging a failure")
    parser.add_argument("--output",type=Path)
    options = parser.parse_args()
    options.binary = options.binary.resolve()
    if not options.binary.is_file():
        parser.error("Build the workspace binaries first")
    hashes = {}
    for path in (options.binary, *(options.binary.parent / name for name in ("rstrbot-openai", "rstrbot-diagnostic", "rstrbot-webhook"))):
        if path.is_file():
            with path.open("rb") as stream:
                hashes[path.name] = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {"database":"postgresql" if options.database_url else "sqlite","valkey":"configured" if options.valkey_url else "off","model":"diagnostic process fixture, not a live AI provider","platform":platform.platform(),"started_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"binary_sha256":hashes,"harness_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"checks":[],"status":"running"}
    started = time.monotonic()
    try:
        exercise(options,report)
        report["status"]="passed"
    except Exception as error:
        report["status"]="failed"
        report["error"]=str(error)
        report["traceback"]=traceback.format_exc()
    report["duration_seconds"]=round(time.monotonic()-started,3)
    report["passed_checks"]=len(report["checks"])
    encoded=json.dumps(report,ensure_ascii=False,indent=2)+"\n"
    if options.output:
        options.output.parent.mkdir(parents=True,exist_ok=True)
        options.output.write_text(encoded)
    print(encoded,end="")
    return int(report["status"]!="passed")


if __name__ == "__main__":
    raise SystemExit(main())
