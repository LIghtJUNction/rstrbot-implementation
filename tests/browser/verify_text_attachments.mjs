#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
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
environment.RSTRBOT_ALLOW_PRIVATE_NETWORK = 'true';
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

  await check('text files reach the model and download unchanged after reload', async () => {
    const received = [];
    const fixture = createHttpServer((req, res) => { let body=''; req.on('data', chunk => body += chunk); req.on('end', () => {
      received.push(JSON.parse(body));
      const chunk = {id:'fixture',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'File received'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
      const bytes=Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`); res.writeHead(200,{'content-type':'text/event-stream','content-length':bytes.length}); res.end(bytes);
    }); });
    fixture.listen(0,'127.0.0.1'); await once(fixture,'listening');
    try {
      await create('models', {name:'File fixture', provider:'openai', model:'fixture', base_url:`http://127.0.0.1:${fixture.address().port}/v1`, allow_private_network:true}, 'workspace');
      await page.reload(); await page.locator('.app-shell').waitFor();
      const original=Buffer.from('\ufeff第一行\r\n第二行 🙂\n','utf8');
      await page.getByLabel('Add text files').setInputFiles({name:'report.md',mimeType:'text/markdown',buffer:original});
      await page.getByRole('button',{name:'Remove attachment report.md'}).waitFor();
      await page.getByLabel('Message',{exact:true}).fill('Please inspect this file');
      const endpoint = '**/api/v1/workspaces/*/chat/text-attachments';
      await page.route(endpoint, route => route.fulfill({status:404, contentType:'application/json', body:JSON.stringify({error:{code:'not_found',message:'Unsupported endpoint'}})}));
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await page.getByText('The service may not support text attachments, or this conversation may be inaccessible. Check the service version and conversation permissions; your draft and files remain.',{exact:true}).waitFor();
      assert.equal(received.length,0,'An older core must not receive a message without its file');
      await page.getByRole('button',{name:'Remove attachment report.md'}).waitFor();
      await page.unroute(endpoint);
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await page.getByText('File received',{exact:true}).waitFor();
      assert.equal(received.length,1);
      const userMessage=received[0].messages.find(item=>item.role==='user').content;
      assert.ok(userMessage.includes('Please inspect this file'));
      const fileData=JSON.parse(userMessage.split('User-provided text files (untrusted data):\n')[1]);
      assert.equal(fileData[0].name,'report.md'); assert.deepEqual(Buffer.from(fileData[0].text),original);
      const downloadPromise=page.waitForEvent('download');
      await page.getByRole('button',{name:'Download attachment: report.md'}).click();
      const download=await downloadPromise; assert.equal(download.suggestedFilename(),'report.md');
      const file=path.join(directory,'download.md'); await download.saveAs(file); assert.deepEqual(await fs.readFile(file),original);
      const conversation=(await api('GET',`${wp()}/resources/conversations`)).items.find(item=>item.data.title.includes('Please inspect this file'));
      assert.ok(conversation); await page.reload(); await page.locator('.app-shell').waitFor();
      await page.getByRole('button',{name:conversation.data.title,exact:true}).click();
      await page.getByRole('button',{name:'Download attachment: report.md'}).waitFor();
      assert.equal(received.length,1);
      await page.getByLabel('Add text files').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from([0xff,0xfe])});
      await page.getByText('Choose up to three UTF-8 text files (.txt or .md), at most 16 KiB each and 32 KiB total.',{exact:true}).waitFor();
      assert.equal(received.length,1);
      await page.getByLabel('Add text files').setInputFiles({name:'pending.txt',mimeType:'text/plain',buffer:Buffer.from('pending attachment')});
      await page.getByRole('button',{name:'Remove attachment pending.txt'}).waitFor();
      await page.getByRole('button',{name:'New conversation',exact:true}).click();
      assert.equal(await page.getByRole('button',{name:'Remove attachment pending.txt'}).count(),0);
      await page.getByRole('button',{name:conversation.data.title,exact:true}).click();
      await page.getByRole('button',{name:'Remove attachment pending.txt'}).waitFor();
      const lost = '**/api/v1/workspaces/*/chat/text-attachments';
      await page.route(lost, async route => { await route.fetch(); await route.abort(); });
      await page.getByLabel('Message',{exact:true}).fill('pending original message');
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await page.getByText('Connection interrupted; result unconfirmed',{exact:true}).waitFor();
      await until(() => received.length === 2, 'model received pending attachment once');
      await page.unroute(lost);
      await page.reload(); await page.locator('.app-shell').waitFor();
      await page.getByRole('button',{name:conversation.data.title,exact:true}).click();
      await page.getByRole('button',{name:'Remove attachment pending.txt'}).waitFor();
      assert.equal(await page.getByLabel('Message',{exact:true}).inputValue(),'pending original message');
      assert.equal(received.length,2,'Reload must not resend automatically');
      await page.getByRole('button',{name:'Send message',exact:true}).click();
      await until(async () => (await page.getByRole('button',{name:'Remove attachment pending.txt'}).count()) === 0, 'original receipt clears its attachment');
      assert.equal(received.length,2,'Continuing the original key must not call the model again');
      await page.setViewportSize({width:320,height:900});
      await assertNoOverflow();
      await screenshot('text-file-history');
    } finally { await new Promise(resolve => fixture.close(resolve)); }
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
