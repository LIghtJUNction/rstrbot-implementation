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
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rstrbot-feedback-repair-'));
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RSTRBOT_')));
const server = spawn(binary, ['--data-dir', path.join(directory, 'server'), '--listen', `127.0.0.1:${port}`, '--web-dir', path.join(root, 'web/dist')], { env: environment, stdio: 'ignore' });
const report = { environment: { os: os.platform(), architecture: os.arch(), node: process.version }, checks: [], hashes: {}, limitations: ['Temporary SQLite instance and Chromium only.', 'Diagnostic chat and schedule runs use the real core/worker; preview delays and lost/late chat receipts intercept HTTP responses.', 'No commercial provider, external delivery, screen reader or physical touch device.'] };
let browser, context, page;
const gates = [];
const evidence = argument('--evidence', directory);
await fs.mkdir(evidence, { recursive: true });
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
const password = 'Feedback repair fixture 2026!';
try {
  await until(async () => { try { return (await fetch(`${base}/health/live`)).ok; } catch { return false; } }, 'startup');
  browser = await chromium.launch({ headless: true, executablePath: argument('--chromium', '/usr/bin/chromium'), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  report.environment.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const api = async (method, route, data) => {
    const response = await context.request.fetch(`${base}/api/v1${route}`, { method, headers: { Origin: base, 'X-RstrBot-Request': '1' }, ...(data ? { data } : {}) });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  await api('POST', '/setup', { token: (await fs.readFile(path.join(directory, 'server/bootstrap.token'), 'utf8')).trim(), username: 'repair_admin', password, workspace: 'Repair checks' });
  const workspace = (await api('GET', '/workspaces')).items[0].id;
  const wp = `/workspaces/${workspace}`;
  const member = (await api('POST', '/admin/users', { username: 'repair_member', password })).user;
  await api('POST', `${wp}/members`, { user_id: member.id, role: 'member' });
  const model = await api('POST', `${wp}/resources/models`, { visibility: 'workspace', data: { name: 'Repair diagnostic', provider: 'diagnostic', model: 'diagnostic', max_tokens: 256 } });
  const conversation = await api('POST', `${wp}/resources/conversations`, { visibility: 'private', data: { title: 'Repair results' } });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message))); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.locator('.app-shell').waitFor();
  await page.evaluate(() => {
    localStorage.setItem('rstrbot.build-prompt.draft.v1', 'UNATTRIBUTED-LEGACY-PRIVATE');
    localStorage.setItem('rstrbot.build-prompt.history.v1', JSON.stringify([{ id: 'old', savedAt: '2026-10-28T00:00:00Z', content: 'UNATTRIBUTED-LEGACY-PRIVATE' }]));
  });
  const nav = (name, p = page) => p.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  const prompt = (p = page) => p.getByLabel('Prompt text', { exact: true });
  const savePrompt = (p = page) => p.getByRole('button', { name: /^(Save browser version|Saved)$/ }).click();
  const signOut = async p => { await p.getByRole('button', { name: 'Sign out', exact: true }).click(); await p.locator('input[name="username"]').waitFor(); };
  const signIn = async (p, username) => {
    await p.locator('input[name="username"]').fill(username); await p.getByLabel('Password', { exact: true }).fill(password);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click(); await p.locator('.app-shell').waitFor();
  };
  await check('legacy private drafts stay sealed; account A can save and export its own version', async () => {
    await nav('Developer tutorials');
    let currentRecipe;
    try { currentRecipe = await fs.readFile(path.resolve(root, '../../recipes/rstrbot/BUILD_PROMPT.md'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      currentRecipe = await fs.readFile(path.join(root, 'docs/RECIPE_BUILD_PROMPT.md'), 'utf8');
    }
    assert.equal(await prompt().inputValue(), currentRecipe);
    assert.equal(await page.getByText('Local version history (0)', { exact: true }).count(), 1);
    await prompt().fill('PRIVATE-ACCOUNT-A-REPAIR'); await savePrompt();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Markdown', exact: true }).click();
    assert.equal(await fs.readFile(await (await downloaded).path(), 'utf8'), 'PRIVATE-ACCOUNT-A-REPAIR');
  });
  const oldTab = await context.newPage(); await oldTab.goto(base); await nav('Developer tutorials', oldTab);
  await until(async () => (await prompt(oldTab).inputValue()) === 'PRIVATE-ACCOUNT-A-REPAIR', 'A draft in second tab');
  await check('switching A to B isolates drafts/history and clears an old tab; API denial remains real', async () => {
    await signOut(page); await oldTab.locator('input[name="username"]').waitFor();
    assert.equal(await oldTab.locator('textarea#build-prompt-draft').count(), 0);
    await signIn(page, 'repair_member');
    await oldTab.locator('.app-shell').waitFor();
    await nav('Developer tutorials'); await nav('Developer tutorials', oldTab);
    assert.equal((await prompt().inputValue()).includes('PRIVATE-ACCOUNT-A-REPAIR'), false);
    assert.equal((await prompt(oldTab).inputValue()).includes('PRIVATE-ACCOUNT-A-REPAIR'), false);
    assert.equal(await page.getByText('Local version history (0)', { exact: true }).count(), 1);
    const denied = await context.request.post(`${base}/api/v1${wp}/resources/models`, { headers: { Origin: base, 'X-RstrBot-Request': '1' }, data: { visibility: 'workspace', data: { name: 'Forbidden', provider: 'diagnostic', model: 'diagnostic' } } });
    assert.equal(denied.status(), 403);
    await prompt().fill('PRIVATE-ACCOUNT-B-REPAIR'); await savePrompt();
    await page.screenshot({ path: path.join(evidence, 'account-b.png') });
    await signOut(page); await signIn(page, 'repair_admin'); await nav('Developer tutorials');
    assert.equal(await prompt().inputValue(), 'PRIVATE-ACCOUNT-A-REPAIR');
    assert.equal(await page.getByText('Local version history (1)', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('rstrbot.build-prompt.draft.v1')), 'UNATTRIBUTED-LEGACY-PRIVATE');
    assert.match(await page.evaluate(() => localStorage.getItem('rstrbot.build-prompt.history.v1')), /UNATTRIBUTED-LEGACY-PRIVATE/);
  });
  await oldTab.close();
  await check('OAuth return navigation invalidates the previous account in another tab without a reload loop', async () => {
    const previous = await context.newPage(); await previous.goto(base); await nav('Developer tutorials', previous);
    assert.equal(await prompt(previous).inputValue(), 'PRIVATE-ACCOUNT-A-REPAIR');
    // Simulate the server-set callback cookie and return navigation; no Google request.
    const reloaded = previous.waitForEvent('load');
    await api('POST', '/auth/login', { username: 'repair_member', password });
    await page.goto(`${base}/?auth=success`); await page.locator('.app-shell').waitFor();
    await reloaded; await previous.locator('.app-shell').waitFor();
    await nav('Developer tutorials', previous);
    assert.equal(await prompt(previous).inputValue(), 'PRIVATE-ACCOUNT-B-REPAIR');
    assert.equal((await prompt(previous).inputValue()).includes('PRIVATE-ACCOUNT-A-REPAIR'), false);
    assert.equal(new URL(page.url()).searchParams.has('auth'), false);
    await previous.close();
    await signOut(page); await signIn(page, 'repair_admin'); await nav('Developer tutorials');
  });
  await check('blocked browser storage preserves editing and export without cross-account fallback', async () => {
    const denied = await browser.newContext({ locale: 'en-US' });
    await denied.addCookies(await context.cookies());
    await denied.addInitScript(() => { Storage.prototype.getItem = () => { throw new DOMException('Denied', 'SecurityError'); }; Storage.prototype.setItem = () => { throw new DOMException('Denied', 'SecurityError'); }; });
    const p = await denied.newPage(); await p.goto(base); await nav('Developer tutorials', p);
    await prompt(p).fill('UNSAVED-STORAGE-DENIED'); await savePrompt(p);
    assert.equal(await prompt(p).inputValue(), 'UNSAVED-STORAGE-DENIED');
    await p.getByText('The browser could not read or save a local version.', { exact: false }).waitFor();
    const download = p.waitForEvent('download'); await p.getByRole('button', { name: 'Export Markdown', exact: true }).click();
    assert.equal(await fs.readFile(await (await download).path(), 'utf8'), 'UNSAVED-STORAGE-DENIED');
    await denied.close();
  });
  await nav('Schedules'); await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const fill = async () => {
    await page.getByLabel('Schedule name', { exact: true }).fill('Daily Tokyo check');
    await page.getByLabel('Instructions', { exact: true }).fill('REPAIR-SCHEDULE-RESULT');
    await page.getByLabel('Model', { exact: true }).selectOption(model.id);
    await page.getByLabel('Conversation for results', { exact: true }).selectOption(conversation.id);
    await page.getByLabel('Schedule', { exact: true }).selectOption('cron');
    await page.getByLabel('Search time zones', { exact: true }).fill('Tokyo');
    await page.getByLabel('Time zone suggestions', { exact: true }).selectOption('Asia/Tokyo');
    await page.getByLabel('Enable schedule', { exact: true }).uncheck();
  };
  const preview = () => page.getByRole('button', { name: 'Preview execution times', exact: true }).click();
  let previewResult;
  await check('daily Tokyo preview uses the real core, labels Taipei conversion and performs no writes/runs', async () => {
    await fill();
    assert.equal(await page.getByLabel('Daily run time', { exact: true }).inputValue(), '09:00');
    const response = page.waitForResponse(r => r.url().endsWith('/schedules/preview') && r.status() === 200);
    await preview(); previewResult = await (await response).json();
    await page.getByText('Schedule paused. These are candidate times only;', { exact: false }).waitFor();
    assert.equal(previewResult.next_runs.length, 5);
    assert.equal(await page.locator('.schedule-preview time').count(), 5);
    for (const line of await page.locator('.schedule-preview li').allTextContents()) { assert.match(line, /09:00.*Asia\/Tokyo/); assert.match(line, /08:00.*Asia\/Taipei/); }
    assert.equal((await api('GET', `${wp}/resources/schedules`)).items.length, 0);
    assert.equal((await api('GET', `${wp}/resources/runs`)).items.length, 0);
    await page.screenshot({ path: path.join(evidence, 'tokyo-preview.png') });
  });
  await check('invalid time zone errors focus the field without losing the draft; hourly/custom options work', async () => {
    await page.getByLabel('Time zone (IANA ID)', { exact: true }).fill('Tokyo'); await preview();
    const field = page.getByLabel('Time zone (IANA ID)', { exact: true });
    await until(async () => (await field.getAttribute('aria-invalid')) === 'true', 'localized timezone error');
    assert.equal(await field.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByLabel('Instructions', { exact: true }).inputValue(), 'REPAIR-SCHEDULE-RESULT');
    await field.fill('Asia/Tokyo');
    await page.getByLabel('Frequency preset', { exact: true }).selectOption('hourly');
    assert.equal(await page.getByLabel('Calendar expression', { exact: true }).inputValue(), '0 0 * * * *');
    await page.getByLabel('Frequency preset', { exact: true }).selectOption('custom');
    await page.getByLabel('Calendar expression', { exact: true }).fill('0 30 1 * * *');
    await field.fill('America/New_York');
    const response = page.waitForResponse(r => r.url().endsWith('/schedules/preview') && r.status() === 200); await preview();
    const actual = await (await response).json();
    assert.equal(actual.dst_policy, 'first_occurrence_skip_gaps');
    const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const times = actual.next_runs.map(at => ny.format(new Date(at * 1000)));
    assert.equal(new Set(times).size, times.length); assert.ok(times.every(time => time.includes('1:30')));
    const fold = actual.next_runs.find(at => new Date(at * 1000).toISOString().startsWith('2026-11-01'));
    if (fold) assert.match(new Date(fold * 1000).toISOString(), /T05:30:00/);
  });
  await check('changed configuration hides and aborts an old preview; a late response cannot refill it', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; }); gates.push({ release });
    let reached = false;
    await page.route('**/schedules/preview', async route => { reached = true; await gate; try { await route.fulfill({ json: previewResult }); } catch {} });
    await preview(); await until(() => reached, 'held preview');
    await page.getByLabel('Time zone (IANA ID)', { exact: true }).fill('Asia/Tokyo');
    await page.getByLabel('Frequency preset', { exact: true }).selectOption('daily');
    release();
    await page.unroute('**/schedules/preview');
    assert.equal(await page.locator('.schedule-preview time').count(), 0);
    const response = page.waitForResponse(r => r.url().endsWith('/schedules/preview') && r.status() === 200); await preview(); await response;
    await until(async () => (await page.locator('.schedule-preview time').count()) === 5, 'current preview');
  });
  await check('saved paused schedule reopens with its actual zone, runs manually, and produces persisted messages', async () => {
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const saved = (await api('GET', `${wp}/resources/schedules`)).items;
    assert.equal(saved.length, 1); assert.equal(saved[0].data.enabled, false); assert.equal(saved[0].data.timezone, 'Asia/Tokyo');
    await page.getByRole('button', { name: 'Daily Tokyo check', exact: true }).click();
    await dialog.getByText('Schedule time zone: Asia/Tokyo', { exact: false }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await until(async () => (await api('GET', `${wp}/conversations/${conversation.id}/messages`)).items.some(m => m.role === 'assistant'), 'scheduled downstream result');
  });
  await nav('Conversations');
  await check('Chinese offline new-chat draft survives; reconnect and record review do not send automatically', async () => {
    await page.getByRole('button', { name: 'Change language', exact: true }).click();
    await page.locator('.composer-selects select').first().selectOption(model.id);
    await page.getByLabel('消息', { exact: true }).fill('REPAIR-OFFLINE-NEW');
    await context.setOffline(true);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('连接中断，结果尚未确认', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), 'REPAIR-OFFLINE-NEW');
    assert.equal(await page.getByRole('heading', { name: 'Failed to fetch', exact: true }).count(), 0);
    assert.equal(await page.getByText('技术详情', { exact: true }).count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(evidence, 'offline-390.png') });
    await context.setOffline(false);
    const before = (await api('GET', `${wp}/resources/runs`)).items.length;
    await page.getByRole('button', { name: '核对会话记录', exact: true }).click();
    assert.equal((await api('GET', `${wp}/resources/runs`)).items.length, before);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await until(async () => (await page.getByLabel('消息', { exact: true }).inputValue()) === '', 'manual retry accepted');
    await page.setViewportSize({ width: 1280, height: 900 });
  });
  await check('English existing-chat offline retry keeps its idempotent intent and sends exactly once', async () => {
    await page.getByRole('button', { name: '切换语言', exact: true }).click();
    await until(async () => (await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0, 'first run done');
    await page.getByLabel('Message', { exact: true }).fill('REPAIR-OFFLINE-EXISTING');
    await context.setOffline(true); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Connection interrupted; result unconfirmed', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'REPAIR-OFFLINE-EXISTING');
    await context.setOffline(false); await page.getByRole('button', { name: 'Review conversation records', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(async () => (await page.getByLabel('Message', { exact: true }).inputValue()) === '', 'existing retry');
  });
  await check('a server-accepted lost acknowledgement retries the same intent; late acknowledgement preserves newer text', async () => {
    await until(async () => !(await api('GET', `${wp}/resources/runs`)).items.some(r => ['running', 'queued'].includes(r.data.status)), 'second run durable terminal');
    // Reopen the actual persisted result before starting this independent failure scenario.
    await page.reload(); await page.locator('.app-shell').waitFor();
    await page.getByRole('button', { name: 'REPAIR-OFFLINE-NEW', exact: true }).click();
    await page.locator('.message.user .message-body').filter({ hasText: 'REPAIR-OFFLINE-EXISTING' }).waitFor();
    await until(async () => await page.locator('.composer-selects select').first().isEnabled(), 'result ready for next intent');
    const content = 'REPAIR-ACK-LOST'; let intercepted;
    await page.route('**/chat', async route => { intercepted = route.request().postDataJSON(); const accepted = await route.fetch(); assert.equal(accepted.status(), 200); report.lostReceipt = { serverStatus: accepted.status(), run: (await accepted.json()).run.id }; await route.abort('failed'); }, { times: 1 });
    await page.getByLabel('Message', { exact: true }).fill(content); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Connection interrupted; result unconfirmed', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), content);
    await until(async () => !(await api('GET', `${wp}/resources/runs`)).items.some(r => ['running', 'queued'].includes(r.data.status)), 'lost-ack run done');
    await page.getByRole('button', { name: 'Review conversation records', exact: true }).click();
    await until(async () => (await page.getByRole('button', { name: 'Send message', exact: true }).count()) === 1, 'can continue same intent');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(async () => (await page.getByLabel('Message', { exact: true }).inputValue()) === '', 'idempotent acknowledgement');
    const messages = (await api('GET', `${wp}/conversations/${intercepted.conversation_id}/messages`)).items;
    assert.equal(messages.filter(m => m.role === 'user' && m.content === content).length, 1);
    assert.equal(messages.filter(m => m.role === 'user' && m.content === 'REPAIR-OFFLINE-EXISTING').length, 1);
    let release; const gate = new Promise(resolve => { release = resolve; }); gates.push({ release }); let accepted = false;
    await page.route('**/chat', async route => { const response = await route.fetch(); accepted = true; await gate; await route.fulfill({ response }); }, { times: 1 });
    await page.getByLabel('Message', { exact: true }).fill('REPAIR-LATE-ACK'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(() => accepted, 'server accepted held ack');
    await page.getByLabel('Message', { exact: true }).fill('NEWER-UNSENT-DRAFT'); release();
    await until(async () => (await page.getByRole('button', { name: 'Stop', exact: true }).count()) === 0 && await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), 'late receipt completed');
    assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'NEWER-UNSENT-DRAFT');
  });
  assert.deepEqual(errors, []);
  for (const name of ['web/src/BuildPromptEditor.tsx', 'web/src/promptStorage.ts', 'web/src/sessionChange.ts', 'web/src/ScheduleFields.tsx', 'web/src/scheduleConfiguration.ts', 'web/src/Resources.tsx', 'web/src/api.ts', 'web/src/ui.tsx', 'web/src/Chat.tsx', 'web/src/style.css', 'web/src/App.tsx', 'docs/RECIPE_BUILD_PROMPT.md', 'web/dist/index.html', 'target/debug/rstrbot', 'tests/browser/verify_feedback.mjs']) report.hashes[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  for (const gate of gates) gate.release();
  await fs.writeFile(path.join(evidence, 'browser-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  const exited = once(server, 'exit'); server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); timer.unref(); })]);
  await fs.rm(directory, { recursive: true, force: true });
}
