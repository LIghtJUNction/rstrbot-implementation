#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const binary = path.resolve(argument('--binary', path.join(root, 'target/debug/rstrbot')));
const executable = argument('--chromium', process.env.RSTRBOT_TEST_CHROMIUM);
const localRequire = createRequire(import.meta.url);
let load = localRequire;
try { load.resolve('playwright'); } catch {
  if (!process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES) throw new Error('Run npm ci in tests/browser, or provide CODEX_PRIMARY_RUNTIME_NODE_MODULES.');
  load = createRequire(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'package.json'));
}
const playwrightVersion = load('playwright/package.json').version;
assert.equal(playwrightVersion, '1.62.1', 'Use the pinned Playwright version');
const { chromium } = load('playwright');

const password = 'Browser fixture password 2026!';
const requestedEvidence = argument('--evidence-dir', '');
const evidence = requestedEvidence ? path.resolve(requestedEvidence) : await fs.mkdtemp(path.join(os.tmpdir(), 'rstrbot-browser-evidence-'));
const screenshots = path.join(evidence, 'screenshots');
const webDir = path.resolve(argument('--web-dir', path.join(root, 'web/dist')));
await fs.mkdir(screenshots, { recursive: true });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function filesBelow(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(file));
    else if (entry.isFile()) result.push(file);
  }
  return result.sort();
}
const inputs = [binary, ...['rstrbot-diagnostic', 'rstrbot-openai', 'rstrbot-webhook'].map(name => path.join(path.dirname(binary), name)), ...await filesBelow(webDir)];
async function inputHashes() {
  const hashes = {};
  for (const file of inputs) hashes[file.startsWith(root + path.sep) ? path.relative(root, file) : path.basename(file)] = sha256(await fs.readFile(file));
  return hashes;
}
const report = {
  status: 'running', started_at: new Date().toISOString(),
  environment: { os: os.platform(), architecture: os.arch(), node: process.version, playwright: playwrightVersion, browser: '', database: 'SQLite', valkey: 'off', locale: 'en-US', timezone: 'Asia/Taipei', reduced_motion: true },
  input_sha256: await inputHashes(), harness_sha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  checks: [], screenshots: [], console_errors: [], network_errors: [],
  limitations: ['Diagnostic worker only; no commercial model or external account.', 'Chromium only. No screen-reader, native desktop, production load or full browser-matrix acceptance.', 'List search covers loaded pages; resource pagination uses the existing offset API.'],
};
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rstrbot-browser-'));
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('RSTRBOT_')) delete environment[key];
const server = spawn(binary, ['--data-dir', directory, '--listen', `127.0.0.1:${port}`, '--web-dir', webDir], { env: environment, detached: os.platform() !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', data => { serverOutput = (serverOutput + data).slice(-200000); });
server.stderr.on('data', data => { serverOutput = (serverOutput + data).slice(-200000); });
let browser, context, page, token = '', workspace, firstModel, privateConversation;
let currentCheck = '';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(fn, description, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await wait(100);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function api(method, route, data, expected = [200], request = context.request) {
  const response = await request.fetch(base + '/api/v1' + route, { method, ...(data === undefined ? {} : { data }), headers: { Origin: base, 'X-RstrBot-Request': '1' } });
  const body = response.status() === 204 ? null : await response.json();
  assert.ok(expected.includes(response.status()), `${method} ${route}: ${response.status()} ${JSON.stringify(body).slice(0, 600)}`);
  return body;
}
const wp = () => `/workspaces/${workspace}`;
async function create(kind, data, visibility = 'private') { return api('POST', `${wp()}/resources/${kind}`, { visibility, data }, [200, 201]); }
async function nav(name) { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click(); }
async function screenshot(name) {
  const file = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  const bytes = await fs.readFile(file);
  report.screenshots.push({ file: path.relative(root, file), sha256: sha256(bytes), bytes: bytes.length, viewport: page.viewportSize() });
}
async function check(name, fn) {
  currentCheck = name;
  const started = performance.now();
  await fn();
  report.checks.push({ name, status: 'passed', duration_ms: Math.round(performance.now() - started) });
  process.stdout.write(JSON.stringify({ passed: name }) + '\n');
}
async function assertNoOverflow() {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(size.document <= size.width + 1 && size.body <= size.width + 1, `Horizontal overflow: ${JSON.stringify(size)}`);
}
async function asAdministrator(fn) {
  // A separate cookie jar changes membership without changing the member's
  // active browser session. All requests still target this temporary server.
  const administrator = await browser.newContext();
  try {
    await api('POST', '/auth/login', { username: 'browser_alice', password }, [200], administrator.request);
    await fn(administrator.request);
  } finally { await administrator.close(); }
}
async function refreshVisibleMembership(role) {
  const response = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/v1/workspaces' || response.request().method() !== 'GET' || response.status() !== 200) return false;
    return (await response.json()).items?.some(item => item.id === workspace && item.role === role);
  });
  // Use the existing visibility/focus refresh path. No arbitrary delay and no
  // access to React internals: wait for the real membership response and DOM.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await response;
}

try {
  await until(async () => { if (server.exitCode !== null) throw new Error('Core exited'); const response = await fetch(base + '/health/live'); return response.ok; }, 'server startup');
  token = (await fs.readFile(path.join(directory, 'bootstrap.token'), 'utf8')).trim();
  browser = await chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== base) {
      report.network_errors.push(`Blocked unexpected origin: ${new URL(route.request().url()).origin}`);
      return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.console_errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) report.console_errors.push(message.text()); });
  const requestedPages = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/resources/conversations')) requestedPages.push(Number(url.searchParams.get('offset') ?? 0)); });

  await check('320px first-run setup exposes both database choices and prevents an unapplied switch', async () => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(base);
    const sqlite = page.getByRole('radio', { name: /^SQLite/ });
    const postgres = page.getByRole('radio', { name: /^PostgreSQL/ });
    await sqlite.waitFor(); await postgres.waitFor();
    assert.equal(await sqlite.isChecked(), true);
    for (const option of [sqlite, postgres]) {
      await option.scrollIntoViewIfNeeded();
      const bounds = await option.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y >= 0 && bounds.y + bounds.height <= 900, 'Database choices must be reachable in a 320px viewport');
    }
    await postgres.check();
    assert.equal(await page.getByRole('button', { name: 'Create workspace', exact: true }).isDisabled(), true);
    await page.getByText('Enter a connection and select “Use database” before creating the workspace.', { exact: true }).waitFor();
    assert.equal((await api('GET', '/setup')).initialized, false, 'Selecting a type cannot initialize the instance');
    await sqlite.check();
    assert.equal(await page.getByRole('button', { name: 'Create workspace', exact: true }).isEnabled(), true);
    await assertNoOverflow(); await screenshot('00-setup-dark-320');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await check('actual first-run form creates an authenticated administrator and workspace', async () => {
    await page.goto(base);
    await page.getByLabel('Setup token').waitFor();
    await page.locator('.auth-features').waitFor();
    await screenshot('01-setup-dark-desktop');
    await page.getByLabel('Setup token').fill(token);
    await page.getByLabel('Username', { exact: true }).fill('browser_alice');
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Workspace name').fill('Browser acceptance workspace');
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.locator('.app-shell').waitFor();
    workspace = (await api('GET', '/workspaces')).items[0].id;
    const cookies = await context.cookies();
    assert.ok(cookies.some(cookie => cookie.name === 'rstrbot_session' && cookie.httpOnly));
  });

  await check('model and plugin forms save real diagnostic connections and invoke their worker', async () => {
    await nav('Models');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page.getByLabel('Display name').fill('Diagnostic browser model');
    await page.getByLabel('Model provider').selectOption('diagnostic');
    await page.getByLabel('Model ID', { exact: true }).fill('diagnostic');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Diagnostic browser model', exact: true }).waitFor();
    firstModel = (await api('GET', `${wp()}/resources/models`)).items.find(model => model.data.name === 'Diagnostic browser model');
    assert.ok(firstModel);
    await page.getByRole('button', { name: 'Run model call test: Diagnostic browser model', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm and send actual test call', exact: true }).click();
    await page.getByText('The server confirmed the test call succeeded.', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
    await nav('Plugins');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page.getByLabel('Instance name').fill('Diagnostic browser tools');
    await page.getByLabel('Installed package').selectOption('diagnostic');
    await page.getByLabel('Enable this instance').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Diagnostic browser tools', exact: true }).waitFor();
    assert.equal((await api('GET', `${wp()}/resources/plugins`)).items.find(plugin => plugin.data.name === 'Diagnostic browser tools').data.enabled, true);
  });

  await check('chat completes a real model-tool-model loop and shows the tool result', async () => {
    await nav('Conversations');
    await page.getByLabel('Message', { exact: true }).fill('/diagnostic/tool browser-tool-sentinel');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(async () => (await api('GET', `${wp()}/resources/runs`)).items.find(run => run.data.status === 'completed' && run.data.content.includes('browser-tool-sentinel')), 'diagnostic round trip');
    await page.locator('.message.assistant .message-body').filter({ hasText: 'Tool result received' }).waitFor();
    assert.ok(await page.locator('.tool-message').count());
    privateConversation = (await api('GET', `${wp()}/resources/conversations`)).items.find(conversation => conversation.data.title.includes('browser-tool-sentinel'));
    assert.ok(privateConversation);
    await screenshot('02-chat-dark-desktop');
    await nav('Runs & inbox');
    await page.getByRole('button', { name: 'Details', exact: true }).first().click();
    await page.getByText('Tool trace', { exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  });

  await check('a delayed real chat acknowledgement preserves a newly typed draft', async () => {
    await nav('Conversations');
    await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
    let received, release;
    const ready = new Promise(resolve => { received = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const pattern = '**/api/v1/workspaces/*/chat';
    await page.route(pattern, async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      received(); await released;
      await route.fulfill({ response });
    });
    try {
      await page.getByLabel('Message', { exact: true }).fill('The submitted first draft');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await Promise.race([ready, wait(15000).then(() => { throw new Error('Chat response was not intercepted'); })]);
      await page.getByLabel('Message', { exact: true }).fill('KEEP THIS NEXT DRAFT');
      release();
      await until(async () => await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), 'chat acknowledgement');
      assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'KEEP THIS NEXT DRAFT');
      await nav('Knowledge'); await nav('Conversations');
      await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
      assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'KEEP THIS NEXT DRAFT');
    } finally { release(); await page.unroute(pattern); }
  });

  await check('a chat acknowledgement from an unmounted view cannot erase a replacement draft', async () => {
    await nav('Conversations');
    await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
    let received, release;
    const ready = new Promise(resolve => { received = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const pattern = '**/api/v1/workspaces/*/chat';
    await page.route(pattern, async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      received(); await released;
      await route.fulfill({ response });
    });
    try {
      await page.getByLabel('Message', { exact: true }).fill('Old view submitted this message');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await Promise.race([ready, wait(15000).then(() => { throw new Error('Chat response was not intercepted'); })]);
      await nav('Knowledge'); await nav('Conversations');
      await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
      await page.getByLabel('Message', { exact: true }).fill('PRESERVE DRAFT FROM THE REPLACEMENT VIEW');
      const acknowledged = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${wp()}/chat` && response.status() === 200);
      release(); await acknowledged;
      await nav('Knowledge'); await nav('Conversations');
      await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
      assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'PRESERVE DRAFT FROM THE REPLACEMENT VIEW');
    } finally { release(); await page.unroute(pattern); }
  });

  await check('switching workspace before conversation creation returns does not launch the abandoned chat', async () => {
    const target = await api('POST', '/workspaces', { name: 'Deferred request destination' }, [200, 201]);
    const targetId = target.workspace?.id ?? target.id;
    assert.ok(targetId);
    // Reload so the server-created workspace is available in the actual picker.
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.getByLabel('Switch workspace', { exact: true }).selectOption(workspace);
    await page.getByLabel('Select model').selectOption(firstModel.id);
    await page.getByLabel('Message', { exact: true }).fill('ABANDONED BEFORE MODEL REQUEST');
    let received, release, created;
    let chatRequests = 0;
    const ready = new Promise(resolve => { received = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const pattern = '**/api/v1/workspaces/*/resources/conversations';
    const observe = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1${wp()}/chat`) chatRequests++; };
    page.on('request', observe);
    await page.route(pattern, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      assert.ok([200, 201].includes(response.status()));
      created = await response.json(); received(); await released;
      await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await Promise.race([ready, wait(15000).then(() => { throw new Error('Conversation creation was not intercepted'); })]);
      await page.getByLabel('Switch workspace', { exact: true }).selectOption(targetId);
      await page.locator('.topbar-workspace').filter({ hasText: 'Deferred request destination' }).waitFor();
      const acknowledged = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/resources/conversations'));
      release(); await acknowledged;
      // The failure mode adds a new HTTP operation after the delayed response.
      // Observe a bounded quiet interval, then also inspect the real DB-backed resource.
      await wait(500);
      assert.equal(chatRequests, 0, 'A departed view must not initiate a model request');
      const empty = await api('GET', `${wp()}/resource/${created.id}`);
      assert.equal(empty.data.active_run ?? '', '');
      assert.equal(empty.data.messages?.length ?? 0, 0);
      assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '');
      await page.getByLabel('Switch workspace', { exact: true }).selectOption(workspace);
      assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'ABANDONED BEFORE MODEL REQUEST');
    } finally { release(); page.off('request', observe); await page.unroute(pattern); }
  });

  await check('a deleted conversation cannot retain cached messages or write controls', async () => {
    const deleted = await create('conversations', { title: 'Deleted conversation cache sentinel' });
    const started = await api('POST', `${wp()}/chat`, { conversation_id: deleted.id, model_id: firstModel.id, content: 'REMOVE THIS CACHED MESSAGE', idempotency_key: randomUUID() }, [200]);
    await until(async () => (await api('GET', `${wp()}/resource/${started.run.id}`)).data.status === 'completed', 'deleted conversation fixture');
    await nav('Knowledge'); await nav('Conversations');
    await page.getByRole('button', { name: deleted.data.title, exact: true }).click();
    await page.locator('.message.user .message-body').filter({ hasText: /^REMOVE THIS CACHED MESSAGE$/ }).waitFor();
    const current = await api('GET', `${wp()}/resource/${deleted.id}`);
    await api('DELETE', `${wp()}/resource/${deleted.id}?version=${current.version}`, undefined, [200, 204]);
    await page.getByText('This conversation is no longer available', { exact: true }).waitFor();
    assert.equal(await page.locator('.message-body').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Reset context', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete conversation', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: privateConversation.data.title, exact: true }).click();
    await page.locator('.message.user .message-body').first().waitFor();
  });

  await check('denied caches stay empty through 503 and remount, then recover after a successful read', async () => {
    const guarded = await create('conversations', { title: 'Cache denial recovery conversation' });
    const started = await api('POST', `${wp()}/chat`, { conversation_id: guarded.id, model_id: firstModel.id, content: 'AUTHORIZED CACHE RECOVERY SENTINEL', idempotency_key: randomUUID() }, [200]);
    await until(async () => (await api('GET', `${wp()}/resource/${started.run.id}`)).data.status === 'completed', 'cache denial fixture');
    await nav('Knowledge'); await nav('Conversations');
    await page.getByRole('button', { name: guarded.data.title, exact: true }).click();
    const body = page.locator('.message.user .message-body').filter({ hasText: /^AUTHORIZED CACHE RECOVERY SENTINEL$/ });
    await body.waitFor();
    let mode = 'denied';
    const metadataPath = `/api/v1${wp()}/resource/${guarded.id}`;
    const historyPath = `/api/v1${wp()}/conversations/${guarded.id}/messages`;
    const metadataPattern = `**${metadataPath}*`;
    const historyPattern = `**${historyPath}*`;
    // Only failures are injected. The initial and recovered content comes from
    // the real authenticated server. Exercise metadata and message-page caches.
    const intercept = deniedStatus => route => mode === 'allowed' ? route.continue() : route.fulfill({
      status: mode === 'denied' ? deniedStatus : 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: mode === 'denied' ? 'access_denied' : 'temporary_outage', message: 'Synthetic cache recovery response' } }),
    });
    const changed = () => create('memories', { title: `Cache refresh ${randomUUID()}`, content: 'Synthetic event to invalidate the active workspace reads.', enabled: false });
    await page.route(metadataPattern, intercept(403));
    await page.route(historyPattern, intercept(404));
    try {
      const deniedReads = Promise.all([[metadataPath, 403], [historyPath, 404]].map(([pathname, status]) => page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.status() === status)));
      await changed(); await deniedReads;
      await page.getByText('This conversation is no longer available', { exact: true }).waitFor();
      mode = 'offline';
      const failedReads = Promise.all([metadataPath, historyPath].map(pathname => page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.status() === 503)));
      await changed(); await failedReads;
      assert.equal(await body.count(), 0, 'An outage cannot restore content after an explicit denial');
      await nav('Knowledge'); await nav('Conversations');
      await page.getByRole('button', { name: guarded.data.title, exact: true }).click();
      await page.getByText('This conversation is no longer available', { exact: true }).waitFor();
      assert.equal(await body.count(), 0, 'A new observer cannot restore denied content');
      mode = 'allowed'; await changed(); await body.waitFor();
    } finally { await page.unroute(metadataPattern); await page.unroute(historyPattern); }

    const memory = await create('memories', { title: 'DENIED COLLECTION CACHE SENTINEL', content: 'Collection cache fixture.', enabled: false });
    await nav('Memory');
    const row = page.getByRole('button', { name: memory.data.title, exact: true });
    await row.waitFor();
    const listPattern = `**/api/v1${wp()}/resources/memories*`;
    mode = 'denied'; await page.route(listPattern, intercept(403));
    try {
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await row.waitFor({ state: 'hidden' });
      mode = 'offline';
      const offline = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/resources/memories') && response.status() === 503);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await offline;
      assert.equal(await row.count(), 0);
      await nav('Knowledge'); await nav('Memory');
      assert.equal(await row.count(), 0, 'Collection cache stays empty after a new observer mounts');
      mode = 'allowed'; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await row.waitFor();
    } finally { await page.unroute(listPattern); }
  });

  await check('knowledge form imports text, exposes indexed state and displays source safely', async () => {
    await nav('Knowledge');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await page.getByLabel('Document title').fill('Browser source document');
    await page.getByLabel('Source text').fill('Source sentinel: copper finches. <img src=x onerror=alert(1)> stays text.');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Browser source document', exact: true }).click();
    await page.getByRole('dialog').getByText('Source sentinel: copper finches.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('dialog').locator('img').count(), 0);
    const record = (await api('GET', `${wp()}/resources/knowledge`)).items.find(item => item.data.title === 'Browser source document');
    assert.equal(record.data.status, 'ready');
    assert.ok(Array.isArray(record.data.chunks) && record.data.chunks.length > 0, 'Ready knowledge must contain searchable chunks');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  });

  await check('visible pagination reaches conversations beyond 200 resources', async () => {
    await create('conversations', { title: 'Pagination ancient sentinel' });
    await wait(1100);
    for (let index = 0; index < 205; index++) await create('conversations', { title: `Pagination fixture ${String(index).padStart(3, '0')}` });
    await nav('Conversations');
    await page.getByLabel('Search loaded conversation titles').fill('Pagination ancient sentinel');
    assert.equal(await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).count(), 0);
    for (let step = 0; step < 3 && !await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).count(); step++) {
      try { await page.getByRole('button', { name: 'Load older conversations', exact: true }).click(); }
      catch (error) { if (!await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).isVisible()) throw error; }
      // Observe the requested result before scheduling another click; network
      // responses can complete before React commits its updated button state.
      try { await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).waitFor({ timeout: 750 }); break; } catch { /* Another page is still needed. */ }
    }
    await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).waitFor();
    assert.ok(requestedPages.includes(100) && requestedPages.includes(200), 'UI must request pages past the first 200 resources');
    await page.getByRole('button', { name: 'Pagination ancient sentinel', exact: true }).click();
  });

  await check('selecting an agent applies its default model and preserves a later explicit override', async () => {
    const model = await create('models', { name: 'Agent preferred model', provider: 'diagnostic', model: 'diagnostic' }, 'workspace');
    await create('agents', { name: 'Browser agent', system_prompt: 'Use the diagnostic fixture.', model_id: model.id, max_steps: 2, knowledge: false, memory: false }, 'workspace');
    await nav('Agents'); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByRole('button', { name: 'Browser agent', exact: true }).waitFor();
    await nav('Conversations');
    await page.getByLabel('Select agent').selectOption({ label: 'Browser agent' });
    await until(async () => await page.getByLabel('Select model').inputValue() === model.id, 'agent default model');
    await page.getByLabel('Select model').selectOption(firstModel.id);
    assert.equal(await page.getByLabel('Select model').inputValue(), firstModel.id);
  });

  await check('changing a model destination requires a replacement or an explicit credential clear', async () => {
    // Configuration-only local URLs: this check never invokes the model.
    const endpoint = base.replace('http:', 'https:');
    const connection = await create('models', { name: 'Credential destination fixture', provider: 'openai', model: 'fixture', base_url: `${endpoint}/model-original`, api_key: 'synthetic-browser-test-key' }, 'workspace');
    await nav('Models'); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Credential destination fixture', exact: true }).click();
    await page.getByLabel('API base URL').fill(`${endpoint}/model-changed`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('The destination changed. Enter a new credential or explicitly clear the saved one.', { exact: true }).waitFor();
    await page.getByLabel('Clear the saved API key', { exact: true }).check();
    assert.equal(await page.getByRole('dialog').locator('input[type=password]').isDisabled(), true);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await until(async () => !await page.locator('dialog[open]').count(), 'saved credential clearing');
    const changed = await api('GET', `${wp()}/resource/${connection.id}`);
    assert.notEqual(changed.data.has_api_key, true);
    assert.equal(changed.data.base_url, `${endpoint}/model-changed`);
    await api('DELETE', `${wp()}/resource/${connection.id}?version=${changed.version}`, undefined, [200, 204]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Credential destination fixture', exact: true }).waitFor({ state: 'hidden' });
    await nav('Conversations');
  });

  await check('desktop light theme and 320px Chinese navigation fit without horizontal overflow', async () => {
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
    await assertNoOverflow(); await screenshot('03-chat-light-desktop');
    await page.getByRole('button', { name: 'Change language', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await page.setViewportSize({ width: 320, height: 900 });
    await page.getByRole('button', { name: '切换到深色主题', exact: true }).click();
    await assertNoOverflow(); await screenshot('04-chat-dark-zh-320');
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '知识库', exact: true }).click();
    await page.getByRole('button', { name: '添加', exact: true }).first().click();
    await assertNoOverflow(); await screenshot('05-knowledge-zh-320');
    const save = page.getByRole('dialog').getByRole('button', { name: '保存', exact: true });
    await save.scrollIntoViewIfNeeded();
    const bounds = await save.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900, 'Mobile dialog actions must be reachable by scrolling');
    await screenshot('06-knowledge-actions-zh-320');
    await page.keyboard.press('Escape');
    await until(async () => !await page.locator('dialog[open]').count(), 'keyboard dismissal');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '切换语言', exact: true }).click();
  });

  await check('an active long draft remains visible after portrait and landscape reflow', async () => {
    await nav('Conversations');
    await page.setViewportSize({ width: 390, height: 844 });
    const input = page.getByLabel('Message', { exact: true });
    const original = await input.inputValue();
    const draft = Array.from({length: 14}, (_, i) => `Draft line ${i + 1}: keep this synthetic text.`).join('\n') + '\nDraft end marker';
    await input.fill(draft); await input.focus(); await input.press('End');
    const state = () => input.evaluate(el => ({ text: el.value, start: el.selectionStart, end: el.selectionEnd, top: el.scrollTop, bottom: el.scrollTop + el.clientHeight, height: el.scrollHeight, focused: document.activeElement === el }));
    const before = await state();
    assert.equal(before.text, draft); assert.equal(before.end, draft.length); // Allow for native textarea bottom padding when checking that the final line remains visible.
    assert.ok(before.bottom >= before.height - 30, JSON.stringify(before));
    await page.setViewportSize({ width: 844, height: 390 }); await page.setViewportSize({ width: 390, height: 844 });
    const after = await state();
    assert.equal(after.text, draft); assert.equal(after.end, draft.length); assert.equal(after.focused, true);
    assert.ok(after.bottom >= after.height - 30, `Draft end not visible after reflow: ${JSON.stringify({before, after})}`);
    await input.fill(original); await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await check('expired session can sign in as another member without cached private resources or drafts', async () => {
    const bob = (await api('POST', '/admin/users', { username: 'browser_bob', password }, [200, 201])).user;
    await api('POST', `${wp()}/members`, { user_id: bob.id, role: 'member' }, [200, 201]);
    const secret = await create('conversations', { title: 'ALICE PRIVATE VISIBILITY SENTINEL' });
    await nav('Conversations');
    await page.getByRole('button', { name: secret.data.title, exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('ALICE PRIVATE DRAFT SENTINEL');
    // Revoke the HTTP session without using the UI logout/reload path. The old
    // query cache is present when authentication expires in an open tab.
    await nav('Knowledge');
    await api('POST', '/auth/logout', {}, [200, 204]);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ timeout: 20000 });
    await page.getByLabel('Username or verified email', { exact: true }).fill('browser_bob');
    await page.getByLabel('Password', { exact: false }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('.app-shell').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(!text.includes(secret.data.title) && !text.includes('ALICE PRIVATE DRAFT SENTINEL'));
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), '');
    const bobResources = (await api('GET', `${wp()}/resources/conversations`)).items;
    assert.ok(!bobResources.some(resource => resource.id === secret.id));
  });

  await check('a member can read another owners shared conversation without write controls', async () => {
    await asAdministrator(async request => {
      const shared = await api('POST', `${wp()}/resources/conversations`, { visibility: 'workspace', data: { title: 'ALICE SHARED READ-ONLY CONVERSATION' } }, [200, 201], request);
      const started = await api('POST', `${wp()}/chat`, { conversation_id: shared.id, model_id: firstModel.id, content: 'ALICE SHARED READABLE MESSAGE', idempotency_key: randomUUID() }, [200], request);
      await until(async () => (await api('GET', `${wp()}/resource/${started.run.id}`, undefined, [200], request)).data.status === 'completed', 'shared conversation fixture');
      await nav('Knowledge'); await nav('Conversations');
      await page.getByRole('button', { name: shared.data.title, exact: true }).click();
      await page.locator('.message.user .message-body').filter({ hasText: /^ALICE SHARED READABLE MESSAGE$/ }).waitFor();
      assert.equal(await page.getByLabel('Message', { exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Reset context', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Delete conversation', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Edit as branch', exact: true }).count(), 0);
      await screenshot('07-shared-member-read-only');
    });
  });

  await check('a live administrator downgrade removes management navigation and its open page', async () => {
    await asAdministrator(async request => {
      const member = (await api('GET', '/auth/me')).user;
      await api('PATCH', `${wp()}/members/${member.id}`, { role: 'admin' }, [200, 204], request);
      try {
        await refreshVisibleMembership('admin');
        const navigation = page.getByRole('navigation', { name: 'Main navigation' });
        await navigation.getByRole('button', { name: 'Members', exact: true }).waitFor();
        await navigation.getByRole('button', { name: 'Plugins', exact: true }).waitFor();
        const approvedRoute = await api('POST', `${wp()}/resources/routes`, { visibility: 'workspace', data: { name: 'MODERATION APPROVED ROUTE', url: 'https://example.invalid/rstrbot-test', enabled: true } }, [200, 201], request);
        await nav('Channels');
        const routeRow = page.locator('.resource-row').filter({ hasText: 'MODERATION APPROVED ROUTE' });
        await routeRow.getByRole('button', { name: 'Disable', exact: true }).waitFor();
        assert.equal(await page.locator('main').getByRole('button', { name: 'Add', exact: true }).count(), 0, 'Workspace administration does not approve new destinations');
        assert.equal(await routeRow.getByRole('button', { name: 'Edit MODERATION APPROVED ROUTE', exact: true }).count(), 0);
        await routeRow.getByRole('button', { name: 'Disable', exact: true }).click();
        await until(async () => (await api('GET', `${wp()}/resource/${approvedRoute.id}`, undefined, [200], request)).data.enabled === false, 'approved route moderation');
        await nav('Members');
        await page.locator('.member-list').waitFor();
        assert.ok(await page.locator('.member-row').count(), 'The administrator view must load real member records before revocation');
        await api('PATCH', `${wp()}/members/${member.id}`, { role: 'member' }, [200, 204], request);
        await refreshVisibleMembership('member');
        await navigation.getByRole('button', { name: 'Members', exact: true }).waitFor({ state: 'hidden' });
        await navigation.getByRole('button', { name: 'Plugins', exact: true }).waitFor({ state: 'hidden' });
        await page.locator('main .chat-layout').waitFor();
        assert.equal(await page.locator('.member-list').count(), 0, 'Cached management records must leave the visible DOM');
        assert.equal(await page.getByRole('button', { name: 'Add member', exact: true }).count(), 0);
        assert.equal((await api('GET', '/workspaces')).items.find(item => item.id === workspace).role, 'member');
        await screenshot('08-role-downgrade');
      } finally {
        await api('PATCH', `${wp()}/members/${member.id}`, { role: 'member' }, [200, 204], request);
      }
    });
  });

  await check('browser runtime and request isolation remain clean', async () => {
    assert.deepEqual(report.console_errors, []);
    assert.deepEqual(report.network_errors, []);
    assert.deepEqual(await inputHashes(), report.input_sha256, 'A binary or WebUI build changed during acceptance');
  });
  report.status = 'passed';
  await fs.rm(path.join(screenshots, 'failure.png'), { force: true });
} catch (error) {
  report.status = 'failed';
  report.checks.push({ name: currentCheck || 'startup', status: 'failed', error: error.stack ?? String(error) });
  if (page) { try { await screenshot('failure'); } catch { /* Preserve the primary failure. */ } }
  process.exitCode = 1;
  process.stderr.write(String(error.stack ?? error) + '\n');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), wait(5000)]);
    if (server.exitCode === null) { try { process.kill(os.platform() === 'win32' ? server.pid : -server.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
  report.finished_at = new Date().toISOString();
  try {
    report.inputs_unchanged = JSON.stringify(await inputHashes()) === JSON.stringify(report.input_sha256);
    if (!report.inputs_unchanged) { report.status = 'invalidated'; process.exitCode = 1; }
  } catch (error) { report.status = 'invalidated'; report.input_read_error = error.message; process.exitCode = 1; }
  await fs.writeFile(path.join(evidence, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(evidence, 'browser-server.log'), token ? serverOutput.split(token).join('[redacted initialization token]') : serverOutput);
  await fs.rm(directory, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ status: report.status, passed: report.checks.filter(check => check.status === 'passed').length, evidence: path.relative(root, path.join(evidence, 'browser.json')) }) + '\n');
}
