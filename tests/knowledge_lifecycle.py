#!/usr/bin/env python3
"""Exercise source versions through real core/model HTTP requests and restart.

The loopback SSE model is a deterministic protocol fixture, not an AI model.
It deliberately returns no source text, so the ledger measures retrieved context
without conflating it with previously generated answers in conversation history.
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
import uuid

from integration import Client, Instance, PASSWORD, ROOT, TERMINAL, wait_for


class Provider(http.server.BaseHTTPRequestHandler):
    records = []
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with self.lock:
            self.records.append(payload)
        event = {'id': 'local', 'model': 'fixture', 'choices': [{'index': 0,
                 'delta': {'role': 'assistant', 'content': 'Synthetic answer; no source text copied.'},
                 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 8, 'total_tokens': 18}}
        body = ('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def exercise(binary, report):
    receiver = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    receiver.daemon_threads = True
    thread = threading.Thread(target=receiver.serve_forever, daemon=True)
    thread.start()
    Provider.records = []
    try:
        with tempfile.TemporaryDirectory(prefix='rstrbot-knowledge-lifecycle-') as folder:
            instance = Instance(Path(folder) / 'core', binary, None, allow_private_network=True)
            try:
                instance.start()
                client = Client(instance.base)
                client.post('/api/v1/setup', {'token': (instance.directory / 'bootstrap.token').read_text(),
                            'username': 'knowledge-fixture', 'password': PASSWORD, 'workspace': 'Knowledge lifecycle'})
                wid = client.get('/api/v1/workspaces')['items'][0]['id']
                base = '/api/v1/workspaces/' + wid

                def create(kind, data, visibility='private'):
                    return client.post(base + '/resources/' + kind, {'visibility': visibility, 'data': data})

                model = create('models', {'name': 'Local SSE fixture (not AI)', 'provider': 'openai', 'model': 'fixture',
                               'base_url': f'http://127.0.0.1:{receiver.server_port}/v1', 'allow_private_network': True}, 'workspace')
                document = create('knowledge', {'title': 'Shift manual', 'text': 'cobalt shift first revision SECRET-PINE-081'})
                conversation = create('conversations', {'title': 'Knowledge lifecycle'})

                def ask(phase):
                    admitted = client.post(base + '/chat', {'conversation_id': conversation['id'], 'model_id': model['id'],
                                           'content': 'cobalt shift', 'idempotency_key': str(uuid.uuid4())})
                    run = wait_for(lambda: client.get(base + '/runs/' + admitted['run']['id']),
                                   lambda item: item['data']['status'] in TERMINAL)
                    assert run['data']['status'] == 'completed', run['data']['status']
                    wait_for(lambda: client.get(base + '/resource/' + conversation['id']),
                             lambda item: not item['data'].get('active_run'))
                    with Provider.lock:
                        request = json.dumps(Provider.records[-1], ensure_ascii=False)
                    citations = run['data'].get('citations', [])
                    observation = {'phase': phase, 'v1_in_request': 'SECRET-PINE-081' in request,
                                   'v2_in_request': 'SECRET-LIME-923' in request,
                                   'citation_hashes': [item.get('source_hash') for item in citations],
                                   'copied_citation_text': any('text' in item or 'excerpt' in item for item in citations)}
                    report['observations'].append(observation)
                    return observation

                first = ask('v1')
                assert first['v1_in_request'] and not first['v2_in_request']
                assert first['citation_hashes'] == [document['data']['source_hash']] and not first['copied_citation_text']
                document = client.request('PATCH', base + '/resource/' + document['id'], {'version': document['version'],
                                          'data': {'title': 'Shift manual', 'text': 'cobalt shift second revision SECRET-LIME-923'}})
                second = ask('v2')
                assert second['v2_in_request'] and not second['v1_in_request']
                assert second['citation_hashes'] == [document['data']['source_hash']] and not second['copied_citation_text']
                assert first['citation_hashes'] != second['citation_hashes']
                client.request('DELETE', base + '/resource/' + document['id'] + '?version=' + str(document['version']), expect=(204,))
                assert not client.get(base + '/knowledge/search?q=cobalt')['items']
                deleted = ask('deleted')
                assert not deleted['v1_in_request'] and not deleted['v2_in_request'] and not deleted['citation_hashes']
                exported = json.dumps(client.get(base + '/export'), ensure_ascii=False)
                assert 'SECRET-PINE-081' not in exported and 'SECRET-LIME-923' not in exported
                instance.stop()
                instance.start()
                client.login('knowledge-fixture')
                assert not client.get(base + '/knowledge/search?q=cobalt')['items']
                restarted = ask('restart')
                assert not restarted['v1_in_request'] and not restarted['v2_in_request'] and not restarted['citation_hashes']
                with Provider.lock:
                    assert len(Provider.records) == 4

                member = client.post('/api/v1/admin/users', {'username': 'knowledge-member', 'password': PASSWORD})['user']
                client.post(base + '/members', {'user_id': member['id'], 'role': 'member'})
                bob = Client(instance.base)
                bob.login('knowledge-member')
                bad = create('knowledge', {'title': 'Damaged private source', 'text': 'cobalt shift repairable source'})
                with sqlite3.connect(instance.directory / 'rstrbot.db') as connection:
                    connection.execute("UPDATE resources SET data=json_set(data, '$.chunks[0].text', 'stale chunk') WHERE id=?", (bad['id'],))
                degraded = client.get(base + '/knowledge/search?q=cobalt')
                assert degraded['degraded'] is True and degraded['degraded_reason'] == 'index_inconsistent'
                assert degraded['inconsistent_documents'] == [{'id': bad['id'], 'title': 'Damaged private source'}], degraded
                assert not degraded['items'], degraded
                before = len(Provider.records)
                admitted = client.post(base + '/chat', {'conversation_id': conversation['id'], 'model_id': model['id'],
                                       'content': 'cobalt shift', 'idempotency_key': str(uuid.uuid4())})
                failed = wait_for(lambda: client.get(base + '/runs/' + admitted['run']['id']),
                                  lambda item: item['data']['status'] in TERMINAL)
                assert failed['data']['status'] == 'failed' and failed['data']['error_code'] == 'knowledge_index_inconsistent', failed
                assert 'Damaged private source' in failed['data']['error'], failed
                assert len(Provider.records) == before, 'A corrupt eligible index must not dispatch to the model'
                wait_for(lambda: client.get(base + '/resource/' + conversation['id']), lambda item: not item['data'].get('active_run'))

                bob_search = bob.get(base + '/knowledge/search?q=cobalt')
                assert bob_search['degraded'] is False and bob_search['inconsistent_documents'] == []
                bob.get(base + '/resource/' + bad['id'], expect=(403, 404))
                bob_conversation = bob.post(base + '/resources/conversations', {'visibility': 'private', 'data': {'title': 'Member chat'}})
                admitted = bob.post(base + '/chat', {'conversation_id': bob_conversation['id'], 'model_id': model['id'],
                                    'content': 'cobalt shift', 'idempotency_key': str(uuid.uuid4())})
                bob_run = wait_for(lambda: bob.get(base + '/runs/' + admitted['run']['id']),
                                   lambda item: item['data']['status'] in TERMINAL)
                assert bob_run['data']['status'] == 'completed' and len(Provider.records) == before + 1

                shared_conversation = create('conversations', {'title': 'Shared chat'}, 'workspace')
                admitted = client.post(base + '/chat', {'conversation_id': shared_conversation['id'], 'model_id': model['id'],
                                       'content': 'cobalt shift', 'idempotency_key': str(uuid.uuid4())})
                shared_run = wait_for(lambda: client.get(base + '/runs/' + admitted['run']['id']),
                                      lambda item: item['data']['status'] in TERMINAL)
                assert shared_run['data']['status'] == 'completed' and len(Provider.records) == before + 2
                assert 'repairable source' not in json.dumps(Provider.records[-1]['messages'])
                before += 1

                repaired = client.request('PATCH', base + '/resource/' + bad['id'], {'version': bad['version'],
                                          'data': {'title': 'Damaged private source', 'text': 'cobalt shift repairable source'}})
                assert client.get(base + '/knowledge/search?q=cobalt')['degraded'] is False
                recovered = ask('repaired')
                assert recovered['citation_hashes'] == [repaired['data']['source_hash']]
                assert len(Provider.records) == before + 2
                disabled = create('knowledge', {'title': 'Disabled source', 'text': 'cobalt shift disabled source', 'enabled': False})
                with sqlite3.connect(instance.directory / 'rstrbot.db') as connection:
                    connection.execute("UPDATE resources SET data=json_set(data, '$.chunks[0].text', 'stale chunk') WHERE id=?", (disabled['id'],))
                assert client.get(base + '/knowledge/search?q=cobalt')['degraded'] is False
                assert ask('disabled_corrupt')['citation_hashes'] == [repaired['data']['source_hash']]
                report['checks'] = ['model request sees the current source generation',
                                    'deletion clears subsequent retrieval and ordinary export',
                                    'restart keeps the deletion and does not replay provider requests',
                                    'corrupt eligible index fails closed before model dispatch and re-saving repairs it',
                                    'private corrupt sources do not block another user or a shared conversation; disabled corrupt sources do not block their owner']
            finally:
                instance.stop()
    finally:
        receiver.shutdown()
        receiver.server_close()
        thread.join(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'target/debug/rstrbot')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    report = {'status': 'running', 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform': platform.platform(), 'database': 'sqlite',
              'scope': 'isolated local HTTP/SSE, synthetic source and model; no commercial model',
              'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'binary_sha256': {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                                for file in (binary, binary.parent / 'rstrbot-openai')},
              'observations': [], 'checks': []}
    started = time.monotonic()
    try:
        exercise(binary, report)
        report['status'] = 'passed'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
    report['duration_seconds'] = round(time.monotonic() - started, 3)
    text = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text, end='')
    if report['status'] != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
