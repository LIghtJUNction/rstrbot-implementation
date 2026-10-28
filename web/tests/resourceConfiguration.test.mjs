import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareConfiguration } from '../src/resourceConfiguration.ts';

const model = { name: 'Model', provider: 'openai', base_url: 'https://one.example/v1', model: 'manual-id', max_tokens: 2048 };
const route = { name: 'Channel', url: 'https://one.example/hook' };
const prepare = (draft, saved, kind = 'models', providers = ['openai', 'diagnostic']) => prepareConfiguration({ kind, draft, saved, providers });
const fields = result => { assert.equal(result.ok, false); return result.issues.map(issue => issue.field); };
const saved = (data) => ({ id: 'saved', workspace_id: 'workspace', owner_id: 'owner', kind: 'models', visibility: 'workspace', version: 1, created_at: 0, updated_at: 0, data });

test('name and model limits count UTF-8 bytes, and providers must be installed', () => {
  assert.equal(prepare({ ...model, name: '中'.repeat(66) }).ok, true);
  assert.ok(fields(prepare({ ...model, name: '中'.repeat(67) })).includes('name'));
  assert.ok(fields(prepare({ ...model, model: '中'.repeat(67) })).includes('model'));
  assert.ok(fields(prepare({ ...model, provider: 'uninstalled' })).includes('provider'));
  assert.ok(fields(prepare(model, undefined, 'models', null)).includes('provider'));
});

test('model and channel URLs reject credentials, parameters, fragments and whitespace', () => {
  for (const url of ['relative', 'ftp://one.example', 'https://user:secret@one.example', 'https://one.example?key=secret', 'https://one.example/#secret', ' https://one.example']) {
    assert.ok(fields(prepare({ ...model, base_url: url })).includes('base_url'), url);
    assert.ok(fields(prepare({ ...route, url }, undefined, 'routes')).includes('url'), url);
  }
});

test('saved credentials remain bound to the full target, and only allowed fields are sent', () => {
  const original = saved({ ...model, has_api_key: true });
  const unchanged = prepare({ ...model, has_api_key: true, status: 'fake' }, original);
  assert.equal(unchanged.ok, true);
  assert.equal('api_key' in unchanged.data, false);
  assert.equal('has_api_key' in unchanged.data, false);
  assert.equal('status' in unchanged.data, false);
  const changed = { ...model, base_url: 'https://one.example/v2' };
  assert.ok(fields(prepare(changed, original)).includes('api_key'));
  assert.equal(prepare({ ...changed, clear_api_key: true }, original).ok, true);
  assert.equal(prepare({ ...changed, api_key: 'replacement' }, original).data.api_key, 'replacement');
  const oldRoute = saved({ ...route, has_token: true, enabled: true });
  assert.ok(fields(prepare({ ...route, url: 'https://two.example/hook' }, oldRoute, 'routes')).includes('token'));
  assert.equal(prepare({ ...route, enabled: false }, oldRoute, 'routes').data.enabled, true);
  assert.equal(prepare(route, undefined, 'routes').data.enabled, false);
});

test('credentials are bounded and errors never echo their value', () => {
  for (const secret of [' '.repeat(4), 'key\nsecret', 'key\u0000secret', '中'.repeat(2731)]) {
    const result = prepare({ ...model, api_key: secret });
    assert.ok(fields(result).includes('api_key'));
    assert.equal(JSON.stringify(result.issues).includes(secret), false);
  }
});

test('token bounds and six-place prices preserve exact microdollars and unknown costs', () => {
  for (const max_tokens of [0, 1.5, 32769, '', NaN]) assert.ok(fields(prepare({ ...model, max_tokens })).includes('max_tokens'));
  for (const input_price_usd of ['-1', '1e2', '0.1234567', '1000000.000001']) assert.ok(fields(prepare({ ...model, input_price_usd })).includes('input_price_usd'));
  const result = prepare({ ...model, input_price_usd: '0.100001', output_price_usd: '0' });
  assert.equal(result.ok, true);
  assert.equal(result.data.input_microusd_per_million, 100001);
  assert.equal(result.data.output_microusd_per_million, 0);
  assert.equal('input_microusd_per_million' in prepare(model).data, false);
});

test('diagnostic configuration excludes network credentials but requires explicit saved-key removal', () => {
  const draft = { ...model, provider: 'diagnostic', api_key: 'stale', allow_private_network: true };
  const result = prepare(draft);
  assert.equal(result.ok, true);
  assert.equal('api_key' in result.data, false);
  assert.equal('base_url' in result.data, false);
  assert.equal(result.data.allow_private_network, false);
  assert.ok(fields(prepare(draft, saved({ ...model, has_api_key: true }))).includes('clear_api_key'));
});
