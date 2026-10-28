import test from 'node:test';
import assert from 'node:assert/strict';
import { promptStorageKey, readPromptState } from '../src/promptStorage.ts';
import { prepareSchedule, timeZoneSuggestions, zonedTime } from '../src/scheduleConfiguration.ts';
import { api, ApiError, TransportError } from '../src/api.ts';

test('saved prompt content belongs to its account and origin; anonymous legacy drafts remain untouched', () => {
  const store = new Map([['rstrbot.build-prompt.draft.v1', 'unattributed private draft']]);
  const storage = { getItem: key => store.get(key) ?? null };
  const key = userId => promptStorageKey({ origin: 'https://one.example', userId });
  store.set(key('alice'), JSON.stringify({ draft: 'Alice private', versions: [{ id: 'v1', savedAt: '2026-10-28T00:00:00Z', content: 'Alice older' }] }));
  assert.equal(readPromptState(storage, key('alice'), 'baseline').draft, 'Alice private');
  for (const k of [key('bob'), promptStorageKey({ origin: 'https://two.example', userId: 'alice' })]) assert.deepEqual(readPromptState(storage, k, 'baseline'), { draft: 'baseline', versions: [] });
  assert.equal(store.get('rstrbot.build-prompt.draft.v1'), 'unattributed private draft');
  assert.equal(readPromptState(storage, key('alice'), 'baseline').versions[0].content, 'Alice older');
});

test('invalid imported history cannot crash the editor; history is bounded without deleting other accounts', () => {
  const valid = Array.from({ length: 25 }, (_, id) => ({ id: String(id), savedAt: '2026-10-28T00:00:00Z', content: `version ${id}` }));
  const result = readPromptState({ getItem: () => JSON.stringify({ draft: 'draft', versions: [null, { id: 'bad', savedAt: 'not a date', content: 'bad' }, ...valid] }) }, 'key', 'baseline');
  assert.equal(result.draft, 'draft'); assert.equal(result.versions.length, 20); assert.equal(result.versions[0].content, 'version 0');
  assert.throws(() => readPromptState({ getItem: () => { throw new Error('storage denied'); } }, 'key', 'baseline'));
});

const draft = { title: 'Daily check', prompt: 'Read my notes', model_id: 'model', conversation_id: 'chat', schedule_type: 'cron', cron: '0 0 9 * * *', timezone: 'Asia/Tokyo', enabled: false };
const prepare = data => prepareSchedule({ draft: data, models: ['model'], conversations: ['chat'] });
test('schedule saves and previews send valid configuration, excluding operational and browser-only fields', () => {
  const result = prepare({ ...draft, status: 'running', next_run: 1, api_key: 'do not send', at: 'stale', interval_seconds: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ...draft, missed_policy: 'skip' });
  const interval = prepare({ ...draft, schedule_type: 'interval', interval_seconds: 60, start_at: 1790000000 });
  assert.equal(interval.ok, true); assert.equal(interval.data.start_at, 1790000000); assert.equal('cron' in interval.data, false);
});

test('invalid schedule fields and missing model/result dependencies produce field-specific recovery', () => {
  for (const [field, value] of [['title', '中'.repeat(67)], ['prompt', ''], ['model_id', 'unavailable'], ['conversation_id', 'unavailable'], ['cron', '* * * * * *'], ['timezone', '']]) {
    const result = prepare({ ...draft, [field]: value });
    assert.equal(result.ok, false); assert.ok(result.issues.some(issue => issue.field === field), field);
  }
  assert.equal(prepare({ ...draft, schedule_type: 'interval', interval_seconds: 59 }).ok, false);
  assert.equal(prepare({ ...draft, schedule_type: 'once', at: 'invalid' }).ok, false);
});

test('time zone suggestions are real browser/runtime IDs and previews label each conversion', () => {
  assert.ok(timeZoneSuggestions().includes('Asia/Tokyo'));
  const at = Date.parse('2026-10-29T00:00:00Z') / 1000;
  assert.match(zonedTime(at, 'Asia/Tokyo', 'en'), /09:00.*Asia\/Tokyo/);
  assert.match(zonedTime(at, 'Asia/Taipei', 'zh'), /08:00.*Asia\/Taipei/);
});

test('transport failure is distinct from server denial and intentional cancellation', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api('/workspaces'), error => error instanceof TransportError && error.message === 'Failed to fetch');
    const controller = new AbortController(); controller.abort();
    const abort = new DOMException('cancelled', 'AbortError');
    globalThis.fetch = async () => { throw abort; };
    await assert.rejects(api('/workspaces', { signal: controller.signal }), error => error === abort);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Denied' } }), { status: 403 });
    await assert.rejects(api('/workspaces'), error => error instanceof ApiError && !(error instanceof TransportError) && error.status === 403);
  } finally { globalThis.fetch = original; }
});
