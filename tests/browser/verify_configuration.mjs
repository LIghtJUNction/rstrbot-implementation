#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const binary = path.resolve(argument('--binary', path.join(root, 'target/debug/rstrbot')));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rstrbot-configuration-'));
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RSTRBOT_')));
const server = spawn(binary, ['--data-dir', path.join(directory, 'server'), '--listen', `127.0.0.1:${port}`, '--web-dir', path.join(root, 'web/dist')], { env: environment, stdio: 'ignore' });
const report = { environment: { os: os.platform(), architecture: os.arch(), node: process.version }, checks: [], hashes: {}, limitations: ['Temporary SQLite instance and Chromium only.', 'Diagnostic discovery uses the actual core/worker; delay and failure cases intercept the discovery HTTP response.', 'No commercial provider, external delivery, screen reader or physical touch device.'] };
let browser, context, page;
const gates = [];
async function until(fn, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) throw new Error(`Core exited: ${server.exitCode}`);
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
}
async function check(name, fn) {
  await fn(); report.checks.push(name); process.stdout.write(`passed: ${name}\n`);
}
const list = id => ({ items: [{ id, name: id }], fixture: false, truncated: false });
try {
  await until(async () => { try { return (await fetch(`${base}/health/live`)).ok; } catch { return false; } }, 'core startup');
  browser = await chromium.launch({ headless: true, executablePath: argument('--chromium', process.env.RSTRBOT_TEST_CHROMIUM), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const api = async (method, route, data) => {
    const response = await context.request.fetch(`${base}/api/v1${route}`, { method, headers: { Origin: base, 'X-RstrBot-Request': '1' }, ...(data ? { data } : {}) });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  };
  await api('POST', '/setup', { token: (await fs.readFile(path.join(directory, 'server/bootstrap.token'), 'utf8')).trim(), username: 'configuration_admin', password: 'Configuration fixture 2026!', workspace: 'Configuration checks' });
  const workspace = (await api('GET', '/workspaces')).items[0].id;
  page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let saves = 0;
  page.on('request', request => { if (request.method() === 'POST' && /\/resources\/(models|routes)$/.test(new URL(request.url()).pathname)) saves++; });
  await page.goto(base); await page.locator('.app-shell').waitFor();
  const nav = name => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const dialog = () => page.getByRole('dialog');
  const openModel = async () => { await nav('Models'); await page.getByRole('button', { name: 'Add', exact: true }).first().click(); };
  const fillModel = async () => {
    await page.getByLabel('Display name', { exact: true }).fill('Configuration model');
    await page.getByLabel('Model provider', { exact: true }).selectOption('openai');
    await page.getByLabel('API base URL', { exact: true }).fill('https://one.example/v1');
    await page.getByLabel('Model ID', { exact: true }).fill('manual-id');
  };
  const overflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll('dialog[open]')].every(node => node.scrollWidth <= node.clientWidth + 1)));
  await openModel();
  await check('labels and inline errors focus the invalid field before advancing', async () => {
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const name = page.getByLabel('Display name', { exact: true });
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    assert.equal(await name.evaluate(node => node === document.activeElement), true);
    const described = await name.getAttribute('aria-describedby');
    assert.ok(described && await page.locator(`[id="${described}"]`).innerText());
    await fillModel();
    await page.getByLabel('API base URL', { exact: true }).fill('https://user:secret@one.example/v1');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert.equal(await page.getByLabel('API base URL', { exact: true }).getAttribute('aria-invalid'), 'true');
    assert.equal(saves, 0);
  });
  await check('diagnostic discovery goes through the actual core and plugin', async () => {
    await page.getByLabel('Model provider', { exact: true }).selectOption('diagnostic');
    await page.getByRole('button', { name: 'Discover model IDs', exact: true }).click();
    await page.getByText('Found 1 model IDs.', { exact: true }).waitFor();
    assert.equal(await page.locator('datalist option').getAttribute('value'), 'diagnostic');
    await fillModel();
  });
  await page.route('**/models/discover', async route => {
    let release;
    const result = new Promise(resolve => { release = resolve; });
    gates.push({ release, body: route.request().postDataJSON() });
    const response = await result;
    try { await route.fulfill({ status: response.status, json: response.body }); } catch { /* An explicitly aborted browser request may already be gone. */ }
  });
  const discover = async () => {
    const count = gates.length;
    await page.getByRole('button', { name: 'Discover model IDs', exact: true }).click();
    await until(() => gates.length === count + 1, 'discovery request');
    return gates[count];
  };
  const aborted = () => page.waitForEvent('requestfailed', request => new URL(request.url()).pathname.endsWith('/models/discover'));
  await check('changing target aborts an old request and ignores its late success', async () => {
    await page.getByLabel('API key', { exact: true }).fill('temporary-fixture-key');
    const old = await discover(); const failure = aborted();
    assert.equal(old.body.api_key, 'temporary-fixture-key');
    await page.getByLabel('API base URL', { exact: true }).fill('https://two.example/v1');
    await failure;
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
    const current = await discover();
    assert.equal('api_key' in current.body, false);
    current.release({ status: 200, body: list('current-id') });
    await page.locator('datalist option[value="current-id"]').waitFor({ state: 'attached' });
    old.release({ status: 200, body: list('stale-id') });
    assert.equal(await page.locator('datalist option[value="stale-id"]').count(), 0);
  });
  await check('cancel and close abort the browser request and isolate a reopened editor', async () => {
    const pending = await discover(); let failure = aborted();
    await page.getByRole('button', { name: 'Cancel discovery', exact: true }).click(); await failure;
    await page.getByText('Stopped waiting.', { exact: false }).waitFor();
    pending.release({ status: 500, body: { error: { message: 'stale failure' } } });
    const closed = await discover(); failure = aborted();
    await dialog().getByRole('button', { name: 'Close', exact: true }).click(); await failure;
    await openModel(); closed.release({ status: 200, body: list('closed-id') });
    assert.equal(await page.getByLabel('Display name', { exact: true }).inputValue(), '');
    assert.equal(await page.locator('datalist option').count(), 0);
    assert.equal(await dialog().getByRole('alert').count(), 0);
  });
  await check('Enter validates each step, and saving is single-flight with exact pricing', async () => {
    await fillModel();
    await page.getByLabel('Model ID', { exact: true }).press('Enter');
    await page.getByLabel('Maximum output tokens', { exact: true }).waitFor(); assert.equal(saves, 0);
    await page.getByLabel('Maximum output tokens', { exact: true }).fill('40000');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    assert.equal(await page.getByLabel('Maximum output tokens', { exact: true }).getAttribute('aria-invalid'), 'true');
    await page.getByLabel('Maximum output tokens', { exact: true }).fill('2048');
    await page.getByLabel('Input price (USD / million tokens)', { exact: true }).fill('0.100001');
    await page.getByLabel('Output price (USD / million tokens)', { exact: true }).fill('0');
    await page.getByLabel('Output price (USD / million tokens)', { exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Review before saving' }).waitFor(); assert.equal(saves, 0);
    let release; const held = new Promise(resolve => { release = resolve; });
    await page.route('**/resources/models', async route => { if (route.request().method() === 'POST') await held; await route.continue(); });
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await until(() => saves === 1, 'save request');
    assert.equal(await dialog().getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
    assert.equal(await dialog().getByRole('button', { name: 'Save configuration', exact: true }).isDisabled(), true);
    await page.keyboard.press('Enter'); assert.equal(saves, 1);
    release(); await dialog().waitFor({ state: 'hidden' });
    const records = (await api('GET', `/workspaces/${workspace}/resources/models`)).items;
    assert.equal(records.length, 1); assert.equal(records[0].data.input_microusd_per_million, 100001);
    assert.equal(records[0].data.output_microusd_per_million, 0);
  });
  await check('channel wizard validates on 320px and saves a disabled route without sending', async () => {
    await nav('Channels');
    await page.getByRole('button', { name: 'Create Webhook', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByLabel('Channel name', { exact: true }).fill('Configuration route');
    await page.getByLabel('Full receiver URL', { exact: true }).fill('https://one.example/hook?token=secret');
    await page.getByLabel('Full receiver URL', { exact: true }).press('Enter');
    assert.equal(await page.getByLabel('Full receiver URL', { exact: true }).getAttribute('aria-invalid'), 'true');
    await overflow();
    await page.getByLabel('Full receiver URL', { exact: true }).fill('https://one.example/hook');
    await page.getByLabel('Full receiver URL', { exact: true }).press('Enter');
    await page.getByLabel('Bearer token (optional)', { exact: true }).fill('fixture-token');
    await page.getByLabel('Bearer token (optional)', { exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Review before saving' }).waitFor(); await overflow();
    assert.equal(saves, 1);
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const records = (await api('GET', `/workspaces/${workspace}/resources/routes`)).items;
    assert.equal(records.length, 1); assert.equal(records[0].data.enabled, false);
    assert.equal(records[0].data.has_token, true); assert.equal('token' in records[0].data, false);
  });
  await check('embedded prompt uses the current recipe while browser drafts remain intact', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await nav('Developer tutorials');
    const snapshot = await fs.readFile(path.join(root, 'docs/RECIPE_BUILD_PROMPT.md'), 'utf8');
    const version = snapshot.match(/^# RstrBot 重建提示词 ([0-9]+\.[0-9]+)/m)[1];
    await page.getByText(`Repository baseline: RstrBot build prompt ${version}`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Prompt text', { exact: true }).inputValue(), snapshot);
    await page.getByLabel('Prompt text', { exact: true }).fill('A preserved browser draft');
    await page.getByRole('button', { name: 'Save browser version', exact: true }).click();
    await page.reload();
    await page.locator('.app-shell').waitFor();
    await nav('Developer tutorials');
    await page.getByText(`Repository baseline: RstrBot build prompt ${version}`, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Prompt text', { exact: true }).inputValue(), 'A preserved browser draft');
  });
  assert.deepEqual(errors, []);
  for (const name of ['web/src/Resources.tsx', 'web/src/resourceConfiguration.ts', 'web/src/ui.tsx', 'web/src/style.css', 'web/dist/index.html', 'target/debug/rstrbot', 'tests/browser/verify_configuration.mjs']) report.hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  report.status = 'passed';
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  for (const gate of gates) gate.release({ status: 503, body: {} });
  await browser?.close();
  const exited = once(server, 'exit'); server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); timer.unref(); })]);
  await fs.rm(directory, { recursive: true, force: true });
}
