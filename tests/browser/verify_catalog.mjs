#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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

  await check('tool catalog limit has actionable errors in both languages and run records', async () => {
    await create('models', {name:'Catalog fixture model', provider:'diagnostic', model:'diagnostic', max_tokens:1024}, 'workspace');
    for (let i=0;i<65;i++) await create('plugins', {name:`Catalog fixture ${i}`, package_id:'diagnostic', enabled:true, config:{}}, 'workspace');
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.getByLabel('Message', {exact:true}).fill('catalog overflow fixture');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByText('More than 64 tools are available. Disable unused tool instances and try again.',{exact:true}).waitFor();
    const run = await until(async () => (await api('GET', `${wp()}/resources/runs`)).items.find(item => item.data.error_code === 'tool_catalog_tool_limit'), 'catalog failure receipt');
    assert.equal(run.data.status,'failed');
    await page.getByRole('button',{name:'Change language',exact:true}).click();
    await page.getByText('可用工具超过 64 个。请停用不需要的工具实例后重试。',{exact:true}).waitFor();
    await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'运行与收件箱',exact:true}).click();
    await page.getByText('可用工具超过 64 个。请停用不需要的工具实例后重试。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'查看',exact:true}).first().click();
    await page.getByRole('dialog',{name:'运行详情'}).getByText('可用工具超过 64 个。请停用不需要的工具实例后重试。',{exact:true}).waitFor();
    await screenshot('catalog-error-zh');
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
