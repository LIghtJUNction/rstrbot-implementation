#!/usr/bin/env python3
"""Observe actual scheduled model requests, terminal outcomes and crash recovery.

Uses disposable SQLite and a loopback OpenAI-compatible protocol fixture, not a
commercial model, external delivery endpoint, virtual clock or multi-node test.
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

from integration import Client, Instance, PASSWORD, ROOT, wait_for


class Provider(http.server.BaseHTTPRequestHandler):
    records = []
    gates = {'cancel': threading.Event(), 'crash': threading.Event()}
    lock = threading.Lock()

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        request = json.dumps(body)
        stage = next(name for name in ('success', 'failure', 'repeat', 'cancel', 'crash') if 'fixture-' + name in request)
        with self.lock:
            self.records.append(stage)
        if stage in ('failure', 'repeat'):
            self.send_response(500)
            self.end_headers()
            return
        if stage in self.gates:
            self.gates[stage].wait(30)
        event = {'id': 'local', 'model': 'fixture', 'choices': [{'index': 0,
                 'delta': {'role': 'assistant', 'content': 'Fixture complete'}, 'finish_reason': 'stop'}]}
        data = ('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode()
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def exercise(binary, report):
    Provider.records = []
    Provider.gates = {'cancel': threading.Event(), 'crash': threading.Event()}
    receiver = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    receiver.daemon_threads = True
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='rstrbot-schedule-outcomes-') as folder:
            instance = Instance(Path(folder) / 'core', binary, allow_private_network=True)
            try:
                instance.start()
                client = Client(instance.base)
                client.post('/api/v1/setup', {'token': (instance.directory / 'bootstrap.token').read_text(),
                            'username': 'schedule-fixture', 'password': PASSWORD, 'workspace': 'Schedule outcomes'})
                wid = client.get('/api/v1/workspaces')['items'][0]['id']
                base = '/api/v1/workspaces/' + wid

                def create(kind, data, visibility='private'):
                    return client.post(base + '/resources/' + kind, {'visibility': visibility, 'data': data})

                model = create('models', {'name': 'Local protocol fixture', 'provider': 'openai', 'model': 'fixture',
                               'base_url': f'http://127.0.0.1:{receiver.server_port}/v1', 'allow_private_network': True})

                def job(name, interval=False, visibility='private'):
                    conversation = create('conversations', {'title': 'fixture-' + name})
                    config = {'title': 'fixture-' + name, 'prompt': 'fixture-' + name,
                              'conversation_id': conversation['id'], 'model_id': model['id'], 'enabled': True}
                    if interval:
                        config.update(schedule_type='interval', interval_seconds=60, start_at=int(time.time()) + 4)
                    else:
                        config.update(schedule_type='once', at=int(time.time()) + 4)
                    return create('schedules', config, visibility)

                def get(item):
                    return client.get(base + '/resource/' + item['id'])

                def count(name):
                    with Provider.lock:
                        return Provider.records.count(name)

                success = job('success')
                completed = wait_for(lambda: get(success), lambda x: x['data'].get('last_result', {}).get('status') == 'completed', timeout=25)
                assert completed['data']['status'] == 'completed' and count('success') == 1
                for _ in range(3):
                    instance.stop(); instance.start(); client.login('schedule-fixture')
                    assert get(success)['data']['last_result']['status'] == 'completed' and count('success') == 1
                report['checks'].append('completed once occurrence and its original run remain after three restarts with one provider request')

                failed = job('failure', visibility='workspace')
                result = wait_for(lambda: get(failed), lambda x: x['data'].get('last_result', {}).get('status') == 'failed', timeout=25)
                assert result['data']['status'] == 'failed' and result['data']['enabled'] is False and count('failure') == 1, result
                report['checks'].append('failed once occurrence reports failed, preserves the run and does not retry')
                bob_id = client.post('/api/v1/admin/users', {'username': 'schedule-member', 'password': PASSWORD})['user']['id']
                client.post(base + '/members', {'user_id': bob_id, 'role': 'member'})
                bob = Client(instance.base); bob.login('schedule-member')
                assert bob.get(base + '/resource/' + failed['id'])['id'] == failed['id']
                bob.get(base + '/runs/' + result['data']['run_id'], expect=(403, 404))
                report['checks'].append('shared schedule visibility does not grant another member access to the private run')

                repeated = job('repeat', interval=True)
                result = wait_for(lambda: get(repeated), lambda x: x['data'].get('last_result', {}).get('status') == 'failed', timeout=25)
                assert result['data']['status'] == 'scheduled' and result['data']['enabled'] is True and result['data']['next_run'] > int(time.time()) and count('repeat') == 1, result
                report['checks'].append('recurring occurrence retains failed last result while scheduling the next future occurrence')

                cancelled = job('cancel')
                wait_for(lambda: count('cancel'), lambda n: n == 1, timeout=25)
                running = wait_for(lambda: get(cancelled), lambda x: bool(x['data'].get('run_id')), timeout=15)
                client.post(base + '/runs/' + running['data']['run_id'] + '/cancel', {}, expect=(204,))
                Provider.gates['cancel'].set()
                result = wait_for(lambda: get(cancelled), lambda x: x['data'].get('last_result', {}).get('status') == 'cancelled', timeout=25)
                assert result['data']['status'] == 'cancelled' and count('cancel') == 1, result
                report['checks'].append('cancelled once occurrence reports cancelled and does not retry')

                crashed = job('crash', interval=True, visibility='workspace')
                wait_for(lambda: count('crash'), lambda n: n == 1, timeout=25)
                before = wait_for(lambda: get(crashed), lambda x: bool(x['data'].get('run_id')), timeout=15)
                claim, run_id = before['data']['claim_id'], before['data']['run_id']
                instance.stop(crash=True)
                Provider.gates['crash'].set()
                for _ in range(3):
                    instance.start(); client.login('schedule-fixture')
                    after = get(crashed)
                    assert after['data']['status'] == 'needs_reconciliation' and after['data']['enabled'] is False, after
                    assert after['data']['claim_id'] == claim and after['data']['run_id'] == run_id and count('crash') == 1
                    assert client.get(base + '/runs/' + run_id)['data']['status'] == 'interrupted'
                    client.post(base + '/schedules/' + crashed['id'] + '/run', {}, expect=(409,))
                    instance.stop()
                report['checks'].append('crash after model receipt preserves one claim and interrupted run through three restarts without replay; manual retry is refused')
                instance.start(); client.login('schedule-fixture'); bob.login('schedule-member')
                pending = get(crashed)
                path = base + '/schedules/' + crashed['id'] + '/reconcile'
                # The receipt can be durable even when its schedule update was
                # lost. Resolve the run from the original admission operation.
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("UPDATE resources SET data=json_set(data,'$.run_id',json('null')) WHERE id=?", (crashed['id'],))
                assert get(crashed)['data']['run_id'] is None
                bob.post(path, {'version': pending['version'], 'acknowledge': True}, expect=(403,))
                client.post(path, {'version': pending['version'], 'acknowledge': False}, expect=(400,))
                client.post(path, {'version': pending['version'] - 1, 'acknowledge': True}, expect=(409,))
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("UPDATE resources SET data=json_set(data,'$.status','running') WHERE id=?", (run_id,))
                client.post(path, {'version': pending['version'], 'acknowledge': True}, expect=(409,))
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("UPDATE resources SET data=json_set(data,'$.status','interrupted') WHERE id=?", (run_id,))
                before_budget = client.get(base + '/budget')
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("CREATE TRIGGER fail_review_event BEFORE INSERT ON events WHEN NEW.kind = 'schedule.reviewed' BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END")
                client.post(path, {'version': pending['version'], 'acknowledge': True}, expect=(503,))
                assert get(crashed)['version'] == pending['version'] and get(crashed)['data']['status'] == 'needs_reconciliation'
                assert count('crash') == 1
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute('DROP TRIGGER fail_review_event')
                reviewed = client.post(path, {'version': pending['version'], 'acknowledge': True})
                assert reviewed['data']['enabled'] is False and reviewed['data']['status'] == 'paused', reviewed
                assert reviewed['data']['last_review']['claim_id'] == claim and reviewed['data']['last_review']['run_id'] == run_id
                assert reviewed['data']['last_review']['outcome'] == 'unknown'
                assert client.get(base + '/budget') == before_budget and count('crash') == 1
                client.post(path, {'version': pending['version'], 'acknowledge': True}, expect=(409,))
                events = client.get(base + '/events?limit=500')['items']
                review_events = [e for e in events if e['resource_id'] == crashed['id'] and e['kind'] == 'schedule.reviewed']
                assert len(review_events) == 1 and review_events[0]['data']['claim_id'] == claim, review_events
                assert client.get(base + '/runs/' + run_id)['data']['status'] == 'interrupted'
                report['checks'].append('unauthorized, stale and active claims are refused; injected event failure rolls back the review; authorized review records one event without extra cost or request')

                enabled = client.request('PATCH', base + '/resource/' + crashed['id'],
                                         {'version': reviewed['version'], 'data': dict(reviewed['data'], enabled=True)})
                assert enabled['data']['status'] == 'scheduled' and enabled['data']['next_run'] > int(time.time())
                instance.stop(); instance.start(); client.login('schedule-fixture')
                assert get(crashed)['data']['last_review']['claim_id'] == claim and count('crash') == 1
                report['checks'].append('explicitly enabling a reviewed recurring schedule selects a future occurrence and survives restart without replay')

                # This fixture uses an actual cancelled run but injects the
                # uncertain schedule state to exercise the expired-once guard.
                prior = get(cancelled)
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("UPDATE resources SET data=json_set(data,'$.status','needs_reconciliation') WHERE id=?", (cancelled['id'],))
                reviewed_once = client.post(base + '/schedules/' + cancelled['id'] + '/reconcile',
                                            {'version': prior['version'], 'acknowledge': True})
                client.request('PATCH', base + '/resource/' + cancelled['id'],
                               {'version': reviewed_once['version'], 'data': dict(reviewed_once['data'], enabled=True)}, expect=(400,))
                future = client.request('PATCH', base + '/resource/' + cancelled['id'],
                                        {'version': reviewed_once['version'], 'data': dict(reviewed_once['data'], enabled=True, at=int(time.time()) + 3600)})
                assert future['data']['status'] == 'scheduled' and future['data']['next_run'] > int(time.time())
                assert count('cancel') == 1
                report['checks'].append('expired one-time schedule requires an explicitly edited future time; old request is not replayed')

                bob.login('schedule-member')
                shared_model = create('models', {'name': 'Shared local fixture', 'provider': 'openai', 'model': 'fixture',
                                      'base_url': f'http://127.0.0.1:{receiver.server_port}/v1', 'allow_private_network': True}, 'workspace')
                bob_conversation = bob.post(base + '/resources/conversations', {'visibility': 'private', 'data': {'title': 'Member fixture'}})
                bob_schedule = bob.post(base + '/resources/schedules', {'visibility': 'private', 'data': {
                    'title': 'Member schedule', 'prompt': 'fixture-success', 'model_id': shared_model['id'],
                    'conversation_id': bob_conversation['id'], 'schedule_type': 'once', 'at': int(time.time()) + 3600, 'enabled': False}})
                with sqlite3.connect(instance.directory / 'rstrbot.db') as database:
                    database.execute("UPDATE resources SET data=json_set(data,'$.status','needs_reconciliation','$.claim_id','simulated-claim') WHERE id=?", (bob_schedule['id'],))
                client.post(base + '/members', {'user_id': bob_id, 'role': 'viewer'})
                bob.post(base + '/schedules/' + bob_schedule['id'] + '/reconcile',
                         {'version': bob_schedule['version'], 'acknowledge': True}, expect=(403,))
                client.post(base + '/members', {'user_id': bob_id, 'role': 'member'})
                no_run = bob.post(base + '/schedules/' + bob_schedule['id'] + '/reconcile',
                                  {'version': bob_schedule['version'], 'acknowledge': True})
                assert no_run['data']['last_review']['run_id'] is None and no_run['data']['last_review']['outcome'] == 'unknown'
                assert no_run['data']['enabled'] is False
                report['checks'].append('downgraded owner is denied; a permitted review without any run receipt remains unknown and paused')
                report['request_counts'] = {name: count(name) for name in ('success', 'failure', 'repeat', 'cancel', 'crash')}
            finally:
                instance.stop()
    finally:
        for gate in Provider.gates.values():
            gate.set()
        receiver.shutdown(); receiver.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'target/debug/rstrbot')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve()
    report = {'status': 'running', 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'platform': platform.platform(), 'database': 'sqlite', 'checks': [],
              'scope': 'real core and loopback HTTP model fixture; no external sink, virtual clock or multi-node',
              'harness_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest()}
    start = time.monotonic()
    try:
        exercise(binary, report)
        report['status'] = 'passed'
    except Exception as error:
        report.update(status='failed', error=str(error), traceback=traceback.format_exc())
    report['duration_seconds'] = round(time.monotonic() - start, 3)
    encoded = json.dumps(report, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(encoded, end='')
    return int(report['status'] != 'passed')


if __name__ == '__main__':
    raise SystemExit(main())
