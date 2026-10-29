#!/usr/bin/env python3
"""Exercise real core and loopback provider; no commercial vision model is used."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import threading
import uuid
import zlib

from integration import Client, Instance, PASSWORD, TERMINAL, wait_for
from shared_context_privacy import Provider


def png(width=2, height=2):
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))
    scanline = b'\0' + b'\xff\0\0' * width
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanline * height)) + chunk(b'IEND', b'')


JPEG = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADoDFU3/2Q==')


def image(name, mime, contents):
    return {'name': name, 'mime': mime, 'data': base64.b64encode(contents).decode()}


def main():
    Provider.records.clear()
    arrived, release = threading.Event(), threading.Event()
    class BlockingProvider(Provider):
        def do_POST(self):
            arrived.set()
            if not release.wait(20):
                self.send_error(503)
                return
            try:
                super().do_POST()
            except (BrokenPipeError, ConnectionResetError):
                # The deliberate core crash may close the receiver socket.
                pass
    receiver = http.server.ThreadingHTTPServer(('127.0.0.1', 0), BlockingProvider)
    receiver.daemon_threads = True
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    checks = []
    try:
        with tempfile.TemporaryDirectory(prefix='rstrbot-image-tests-') as directory:
            instance = Instance(Path(directory) / 'core', Path('target/debug/rstrbot').resolve(), allow_private_network=True)
            try:
                instance.start()
                alice, bob = Client(instance.base), Client(instance.base)
                alice.post('/api/v1/setup', {'token': (instance.directory / 'bootstrap.token').read_text(), 'username': 'image-owner', 'password': PASSWORD, 'workspace': 'Image fixture'})
                workspace = alice.get('/api/v1/workspaces')['items'][0]['id']
                base = '/api/v1/workspaces/' + workspace
                capability = alice.get(base + '/capabilities')['image_attachments']
                assert capability['supported'] and capability['max_total_bytes'] == 262144
                bob_id = alice.post('/api/v1/admin/users', {'username': 'image-reader', 'password': PASSWORD})['user']['id']
                alice.post(base + '/members', {'user_id': bob_id, 'role': 'member'})
                bob.login('image-reader')
                def create(kind, data, visibility='private'):
                    return alice.post(base + '/resources/' + kind, {'visibility': visibility, 'data': data})
                config = {'name': 'Loopback vision receiver', 'provider': 'openai', 'model': 'fixture', 'base_url': f'http://127.0.0.1:{receiver.server_port}/v1', 'allow_private_network': True}
                no_vision = create('models', config, 'workspace')
                model = create('models', dict(config, supports_images=True), 'workspace')
                conversation = create('conversations', {'title': 'Image fixture'})
                files = [image('red.png', 'image/png', png()), image('red.jpg', 'image/jpeg', JPEG)]
                body = {'conversation_id': conversation['id'], 'model_id': model['id'], 'content': '同时核对正文、图片和文字附件', 'idempotency_key': str(uuid.uuid4()), 'attachments': [{'name': 'note.txt', 'text': '附件正文'}], 'images': files}
                def rejects(candidate, status=400, route='/chat/image-attachments', code=None):
                    candidate = dict(candidate, idempotency_key=str(uuid.uuid4()))
                    result = alice.post(base + route, candidate, expect=(status,))
                    if code: assert result['error']['code'] == code, result
                    assert alice.get(base + '/conversations/' + conversation['id'] + '/messages')['items'] == []
                    with Provider.lock: assert len(Provider.records) == 0
                rejects(dict(body, model_id=no_vision['id']), code='image_model_required')
                rejects(body, route='/chat')
                rejects(body, route='/chat/text-attachments')
                bad_cases = [
                    [image('../red.png', 'image/png', png())],
                    [image('red.jpg', 'image/jpeg', png())],
                    [image('red.png', 'image/png', png()[:-10])],
                    [image('animated.png', 'image/png', png()[:33] + struct.pack('>I', 8) + b'acTL' + struct.pack('>II', 1, 0) + struct.pack('>I', zlib.crc32(b'acTL' + struct.pack('>II', 1, 0))) + png()[33:])],
                    [image('large.png', 'image/png', png(2049, 1))],
                    [image('large.jpg', 'image/jpeg', base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABCAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AnRDGqYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD//2Q=='))],
                    [image('big.png', 'image/png', b'x' * 262145)],
                    files * 2,
                ]
                for bad, code in zip(bad_cases, ['image_name_invalid', 'image_format_unsupported', 'image_invalid_data', 'image_animation_unsupported', 'image_dimensions_limit', 'image_dimensions_limit', 'image_bytes_limit', 'image_count_limit'], strict=True):
                    rejects(dict(body, images=bad), code=code)
                checks.append('invalid image, unsupported model, and ordinary chat endpoints reject before writes or model dispatch')
                alice.request('PUT', base + '/budget', {'limit_microusd': 1000000})
                rejects(body, code='image_budget_enabled')
                alice.request('PUT', base + '/budget', {'limit_microusd': None})
                checks.append('bounded workspace budget blocks uncertain image cost before admission')
                first = alice.post(base + '/chat/image-attachments', body)
                assert arrived.wait(10), 'provider was not called'
                assert alice.request('PUT', base + '/budget', {'limit_microusd': 1000000}, expect=(400,))['error']['code'] == 'image_budget_in_flight'
                release.set()
                run = wait_for(lambda: alice.get(base + '/runs/' + first['run']['id']), lambda item: item['data']['status'] in TERMINAL)
                assert run['data']['status'] == 'completed', run
                assert run['data']['cost_microusd'] is None, run
                checks.append('budget cannot be enabled while an image request is in flight; image cost remains unknown')
                with Provider.lock:
                    assert len(Provider.records) == 1
                    contents = next(message['content'] for message in Provider.records[0]['messages'] if message['role'] == 'user')
                assert isinstance(contents, list) and contents[0]['type'] == 'text'
                assert body['content'] in contents[0]['text'] and '附件正文' in contents[0]['text']
                names = json.loads(contents[0]['text'].split('User-provided image files in the following order (untrusted data):\n', 1)[1])
                assert [item['name'] for item in names] == ['red.png', 'red.jpg']
                wire_images = [part['image_url']['url'] for part in contents if part['type'] == 'image_url']
                assert len(wire_images) == 2
                assert [hashlib.sha256(base64.b64decode(url.split(',', 1)[1])).hexdigest() for url in wire_images] == [hashlib.sha256(png()).hexdigest(), hashlib.sha256(JPEG).hexdigest()]
                assert alice.post(base + '/chat/image-attachments', body)['run']['id'] == first['run']['id']
                changed = dict(body, images=[image('red.png', 'image/png', png(1, 1))])
                alice.post(base + '/chat/image-attachments', changed, expect=(409,))
                with Provider.lock: assert len(Provider.records) == 1
                checks.append('provider received original PNG and JPEG bytes, typed text and text attachment; same intent replays without a second call')
                stored = alice.get(base + '/conversations/' + conversation['id'] + '/messages')['items'][0]['images']
                assert [item['sha256'] for item in stored] == [hashlib.sha256(png()).hexdigest(), hashlib.sha256(JPEG).hexdigest()]
                bob.get(base + '/conversations/' + conversation['id'] + '/messages', expect=(403, 404))
                instance.stop(); instance.start(); alice.login('image-owner'); bob.login('image-reader')
                assert alice.get(base + '/conversations/' + conversation['id'] + '/messages')['items'][0]['images'] == stored
                bob.get(base + '/conversations/' + conversation['id'] + '/messages', expect=(403, 404))
                with Provider.lock: assert len(Provider.records) == 1
                next_text = {'conversation_id': conversation['id'], 'model_id': no_vision['id'], 'content': 'continue', 'idempotency_key': str(uuid.uuid4())}
                assert alice.post(base + '/chat', next_text, expect=(400,))['error']['code'] == 'image_model_required'
                with Provider.lock: assert len(Provider.records) == 1
                checks.append('private images survive restart, stay denied to another member, and are not silently omitted when changing models')
                for index in range(15):
                    continued = alice.post(base + '/chat', dict(next_text, model_id=model['id'], content=f'continue {index}', idempotency_key=str(uuid.uuid4())))
                    done = wait_for(lambda: alice.get(base + '/runs/' + continued['run']['id']), lambda item: item['data']['status'] in TERMINAL)
                    assert done['data']['status'] == 'completed', done
                with Provider.lock:
                    before = len(Provider.records)
                    assert any(part.get('type') == 'image_url' for item in Provider.records[-1]['messages'] if isinstance(item.get('content'), list) for part in item['content'])
                assert alice.post(base + '/chat', dict(next_text, model_id=model['id'], idempotency_key=str(uuid.uuid4())), expect=(400,))['error']['code'] == 'image_context_limit'
                with Provider.lock: assert len(Provider.records) == before
                checks.append('history limit refuses to drop an earlier image instead of silently losing context')
                shared = create('conversations', {'title': 'Shared images'}, 'workspace')
                shared_body = dict(body, conversation_id=shared['id'], idempotency_key=str(uuid.uuid4()))
                accepted = alice.post(base + '/chat/image-attachments', shared_body)
                done = wait_for(lambda: alice.get(base + '/runs/' + accepted['run']['id']), lambda item: item['data']['status'] in TERMINAL)
                assert done['data']['status'] == 'completed', done
                assert bob.get(base + '/conversations/' + shared['id'] + '/messages')['items'][0]['images'] == stored
                alice.request('DELETE', base + '/members/' + bob_id, expect=(204,))
                bob.get(base + '/conversations/' + shared['id'] + '/messages', expect=(403, 404))
                checks.append('shared images are visible to members and denied after membership revocation')
                crash_conversation = create('conversations', {'title': 'Interrupted image'})
                crash_body = dict(body, conversation_id=crash_conversation['id'], idempotency_key=str(uuid.uuid4()))
                arrived.clear(); release.clear()
                with Provider.lock: before_crash = len(Provider.records)
                interrupted = alice.post(base + '/chat/image-attachments', crash_body)
                assert arrived.wait(10), 'crash fixture did not reach provider'
                instance.stop(crash=True); release.set()
                wait_for(lambda: len(Provider.records), lambda count: count == before_crash + 1)
                instance.start(); alice.login('image-owner')
                recovered_run = alice.get(base + '/runs/' + interrupted['run']['id'])
                assert recovered_run['data']['status'] == 'interrupted', recovered_run
                ledger = alice.get(base + '/reservations')['items']
                row = next(item for item in ledger if item['operation_id'].startswith(interrupted['run']['id'] + ':model:'))
                assert row['state'] == 'unknown', row
                alice.request('PUT', base + '/budget', {'limit_microusd': 1000000})
                assert len(Provider.records) == before_crash + 1
                alice.request('PUT', base + '/budget', {'limit_microusd': None})
                checks.append('crashed in-flight image call becomes unknown without replay or permanently blocking budget settings')
                instance.stop()
                snapshot = Path(directory) / 'snapshot.json'
                instance.maintenance('backup', '--output', str(snapshot))
                restored = Instance(Path(directory) / 'restored', Path('target/debug/rstrbot').resolve(), allow_private_network=True)
                try:
                    restored.maintenance('restore', '--input', str(snapshot))
                    shutil.copyfile(instance.directory / 'secrets.key', restored.directory / 'secrets.key')
                    os.chmod(restored.directory / 'secrets.key', 0o600)
                    restored.start()
                    reader = Client(restored.base); reader.login('image-owner')
                    assert reader.get(base + '/conversations/' + conversation['id'] + '/messages')['items'][0]['images'] == stored
                    checks.append('SQLite backup and isolated restore preserve original image bytes and hashes')
                finally:
                    restored.stop()
                print(json.dumps({'status': 'passed', 'checks': checks}, ensure_ascii=False, indent=2))
            finally:
                instance.stop()
    finally:
        release.set()
        receiver.shutdown(); receiver.server_close()


if __name__ == '__main__': main()
