/**
 * Optional full-browser QA: node tests/browser-check.mjs
 * Requires Playwright and an installed Chromium. Set SEO_YUNA_CHROMIUM to an
 * alternate executable, and SEO_YUNA_QA_DIR for screenshots outside this repo.
 * Uses a fresh local server/browser profile, synthetic credentials, and mocked
 * GitHub requests. Every other external request is blocked. No live writes occur.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VAULT_STORAGE_KEY } from '../assets/credential-vault.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const qaDirectory = process.env.SEO_YUNA_QA_DIR ?? resolve(root, '..', 'seo-yuna-qa');
const catalogText = await readFile(resolve(root, 'data.json'), 'utf8');
const catalog = JSON.parse(catalogText);
const owner = { id: 121861881, login: 'budhi-halim' };
const repository = { id: 1423899802, full_name: 'budhi-halim/seo-yuna', owner,
  default_branch: 'master', permissions: { push: true } };
const repoPath = '/repos/budhi-halim/seo-yuna';
const workflowPath = `${repoPath}/actions/workflows/studio.yml`;
const USERNAME = 'browser fixture local username';
const PASSWORD = 'lantern walnut meadow river fixture';
const TOKEN = 'github_pat_BROWSER_QA_SYNTHETIC_NOT_A_REAL_TOKEN_1234567890';
const secretStrings = [USERNAME, PASSWORD, TOKEN];

function fixtureTheme(number) {
  return { id: `qa-browser-theme-${number}`, name: `Browser verification fixture ${number}`,
    variations: [{ id: `qa-browser-variation-${number}`, name: 'Existing prompt text reused for verification',
      prompt: catalog[0].variations[0].prompt }] };
}
function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
function bounded(promise, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10000);
  })]).finally(() => clearTimeout(timer));
}

const contentTypes = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!(relative === 'index.html' || relative === 'data.json' || relative === 'rulebook.txt' ||
        relative === 'version.txt' || /^assets\/[A-Za-z0-9_.-]+$/.test(relative))) {
      response.writeHead(404).end(); return;
    }
    const filename = resolve(root, relative);
    assert.ok(filename.startsWith(root.endsWith(sep) ? root : root + sep));
    const bytes = await readFile(filename);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filename)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolvePromise, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolvePromise);
});
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(qaDirectory, { recursive: true });

function mockGitHub() {
  const gates = new Map();
  const allGates = new Set();
  const state = { requests: [], blocked: [], failures: [], blobs: new Map(), runs: [],
    dispatchMode: 'accept', showRuns: true, closing: false };
  state.hold = (method, pathname) => {
    const entered = deferred();
    const released = deferred();
    const finished = deferred();
    const gate = { entered: entered.promise, finished: finished.promise, signalEntered: entered.resolve,
      released: released.promise, release: released.resolve, signalFinished: finished.resolve, cancelled: false };
    gates.set(`${method} ${pathname}`, gate);
    allGates.add(gate);
    return gate;
  };
  state.close = () => { state.closing = true; for (const gate of allGates) gate.release(); };
  state.route = async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) { await route.continue(); return; }
    if (url.origin !== 'https://api.github.com') {
      state.blocked.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient'); return;
    }
    const method = request.method();
    const headers = request.headers();
    const body = request.postData();
    const cors = { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,content-type,x-github-api-version',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
    if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    const call = { method, pathname: url.pathname, url: url.href, headers, body };
    state.requests.push(call);
    const gate = gates.get(`${method} ${url.pathname}`);
    if (gate) {
      gates.delete(`${method} ${url.pathname}`);
      gate.signalEntered();
      await gate.released;
    }
    const json = value => route.fulfill({ status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    try {
      if (method === 'GET' && url.pathname === '/user') return await json(owner);
      if (method === 'GET' && url.pathname === repoPath) return await json(repository);
      if (method === 'GET' && url.pathname === workflowPath) return await json({ id: 1,
        path: '.github/workflows/studio.yml', state: 'active' });
      if (method === 'GET' && url.pathname === `${repoPath}/contents/data.json`) {
        assert.equal(url.search, '?ref=master');
        return await route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: catalogText });
      }
      if (method === 'POST' && url.pathname === `${repoPath}/git/blobs`) {
        const value = JSON.parse(body);
        assert.deepEqual(Object.keys(value).sort(), ['content', 'encoding']);
        assert.equal(value.encoding, 'utf-8');
        const sha = createHash('sha1').update(`blob ${Buffer.byteLength(value.content)}\0`).update(value.content).digest('hex');
        state.blobs.set(sha, value.content);
        return await route.fulfill({ status: 201, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ sha }) });
      }
      if (method === 'POST' && url.pathname === `${workflowPath}/dispatches`) {
        const value = JSON.parse(body);
        assert.deepEqual(Object.keys(value).sort(), ['inputs', 'ref']);
        assert.equal(value.ref, 'master');
        assert.deepEqual(Object.keys(value.inputs).sort(), ['payload_blob_sha', 'request_id', 'sha256']);
        const staged = state.blobs.get(value.inputs.payload_blob_sha);
        assert.equal(typeof staged, 'string');
        assert.equal(value.inputs.sha256, createHash('sha256').update(staged).digest('hex'));
        const run = { id: 50001 + state.runs.length, display_title: `Import ${value.inputs.request_id}`,
          path: '.github/workflows/studio.yml', head_branch: 'master', event: 'workflow_dispatch',
          actor: owner, repository, status: 'queued', conclusion: null };
        state.runs.push(run);
        if (state.dispatchMode === 'unknown') { await route.abort('failed'); return; }
        return await json({ workflow_run_id: run.id });
      }
      if (method === 'GET' && url.pathname === `${workflowPath}/runs`) return await json({ workflow_runs: state.showRuns ? state.runs : [] });
      if (method === 'GET' && /^\/repos\/budhi-halim\/seo-yuna\/actions\/runs\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1));
        const run = state.runs.find(value => value.id === id);
        assert.ok(run); return await json(run);
      }
      if (method === 'GET' && url.pathname.endsWith('/jobs')) return await json({ jobs: [] });
      throw new Error(`Unexpected mock endpoint: ${method} ${url.pathname}`);
    } catch (error) {
      if (!gate?.cancelled && !state.closing) state.failures.push(error.message);
      await route.abort('failed').catch(() => {});
    } finally { gate?.signalFinished(); }
  };
  return state;
}

let browser;
const contexts = new Set();
const contextMocks = new Map();
const results = [];
async function session(viewport = { width: 1440, height: 1000 }, mobile = false) {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile,
    deviceScaleFactor: 1, serviceWorkers: 'block', colorScheme: 'light' });
  contexts.add(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const mock = mockGitHub();
  contextMocks.set(context, mock);
  await context.route('**/*', mock.route);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page.waitForFunction(count => document.querySelector('#theme-count')?.textContent === String(count) &&
    !document.querySelector('#open-connect')?.disabled, catalog.length);
  return { page, context, mock, pageErrors };
}

async function connected(page) {
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.state === 'connected');
}
async function disconnected(page) {
  await page.waitForFunction(() => document.querySelector('#connection-status')?.dataset.state === 'disconnected' &&
    !document.querySelector('#open-connect')?.disabled);
}
async function access(page) { await page.locator('#open-connect').click(); await page.locator('#connect-dialog').waitFor({ state: 'visible' }); }
async function configure(page) {
  await access(page);
  await page.locator('#access-token').fill(TOKEN);
  await page.locator('#access-username').fill(USERNAME);
  await page.locator('#access-password').fill(PASSWORD);
  await page.locator('#access-password-confirm').fill(PASSWORD);
  await page.locator('#connect-button').click();
  await connected(page);
}
async function unlock(page, username = USERNAME, password = PASSWORD) {
  await page.locator('#access-username').fill(username);
  await page.locator('#access-password').fill(password);
  await page.locator('#connect-button').click();
}
async function screenshot(page, name) {
  await page.screenshot({ path: resolve(qaDirectory, name), fullPage: true });
}
async function stored(page) {
  return page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
}
async function audit(session, { expectVault = true } = {}) {
  const { page, mock, pageErrors } = session;
  const storage = await stored(page);
  assert.equal(typeof storage[VAULT_STORAGE_KEY] === 'string', expectVault);
  const serialized = JSON.stringify(storage);
  for (const secret of secretStrings) assert.ok(!serialized.includes(secret), 'Browser storage must not expose a sign-in string or token');
  assert.ok(!serialized.includes('qa-browser-theme-'), 'Draft/import contents must not enter stored receipts');
  for (const call of mock.requests) {
    for (const secret of secretStrings) assert.ok(!`${call.url}${call.body ?? ''}`.includes(secret), 'No credentials belong in URLs or request bodies');
    if (call.headers.authorization) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    if (call.method === 'POST' || call.pathname === '/user') assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    for (const [key, value] of Object.entries(call.headers)) {
      if (key !== 'authorization') for (const secret of secretStrings) assert.ok(!value.includes(secret), 'Only the GitHub Authorization header may contain the token');
    }
  }
  assert.deepEqual(mock.blocked, [], 'The app must not attempt any non-GitHub external request');
  assert.deepEqual(mock.failures, []);
  assert.deepEqual(pageErrors, []);
}

async function check(name, operation) {
  const before = new Set(contexts);
  const started = Date.now();
  try {
    await operation();
    results.push({ name, passed: true });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, passed: false });
    for (const context of contexts) if (!before.has(context)) {
      const page = context.pages()[0];
      if (page && !page.isClosed()) await screenshot(page, `failure-${name}.png`).catch(() => {});
    }
    console.error(`FAIL ${name}: ${error.message}`);
    const testLocation = error.stack?.split('\n').find(line => line.includes('browser-check.mjs:'));
    if (testLocation) console.error(testLocation.trim());
  } finally {
    for (const context of contexts) if (!before.has(context)) {
      contextMocks.get(context)?.close();
      await context.close(); contexts.delete(context); contextMocks.delete(context);
    }
  }
}

try {
  browser = await chromium.launch({ headless: true,
    ...(process.env.SEO_YUNA_CHROMIUM ? { executablePath: process.env.SEO_YUNA_CHROMIUM } : {}) });

  await check('desktop-reader-login-and-storage', async () => {
    const s = await session(); const { page, context, mock } = s;
    assert.equal(await page.locator('#total-prompts').textContent(), String(catalog.reduce((sum, theme) => sum + theme.variations.length, 0)));
    assert.equal(mock.requests.length, 0, 'Public startup does not call an owner service or verify credentials');
    await screenshot(page, 'desktop-reader.png');
    await page.locator('#theme-select').selectOption(catalog[0].id);
    await page.locator('.prompt-reading-area').focus();
    await page.keyboard.press('a');
    assert.equal(await page.locator('#theme-select').inputValue(), catalog.at(-1).id);
    await page.keyboard.press('d');
    assert.equal(await page.locator('#theme-select').inputValue(), catalog[0].id);
    await page.keyboard.press('w');
    assert.equal(await page.locator('#variation-select').inputValue(), catalog[0].variations.at(-1).id);
    await page.keyboard.press('s');
    assert.equal(await page.locator('#variation-select').inputValue(), catalog[0].variations[0].id);
    await page.keyboard.press('q');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `1. ${catalog[0].name}`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('q'); await page.keyboard.press('q');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), catalog[0].name);
    await page.keyboard.press('e');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), catalog[0].variations[0].prompt);
    await page.locator('#theme-search').fill(`${catalog.length} ${catalog.at(-1).name}`);
    assert.equal(await page.locator('#theme-select').inputValue(), catalog[0].id);
    assert.match(await page.locator('#theme-search-status').textContent(), /1 match/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#theme-search').inputValue(), '');
    await page.locator('#tab-import').click();
    const draft = JSON.stringify([fixtureTheme(1)]);
    await page.locator('#json-input').fill(draft);
    await page.locator('#validate-button').click();
    assert.equal(await page.locator('#submit-button').isDisabled(), true);
    await access(page);
    assert.equal(await page.locator('#token-setup-guide').isVisible(), true);
    const tokenLink = new URL(await page.locator('#create-token-link').getAttribute('href'));
    assert.equal(tokenLink.origin, 'https://github.com');
    assert.equal(tokenLink.searchParams.get('target_name'), 'budhi-halim');
    await screenshot(page, 'desktop-setup.png');
    await page.locator('#close-connect').click();
    await configure(page);
    for (const id of ['access-token', 'access-username', 'access-password', 'access-password-confirm']) assert.equal(await page.locator(`#${id}`).inputValue(), '');
    await page.locator('#close-connect').click();
    assert.equal(await page.locator('#json-input').inputValue(), draft, 'Logging in must preserve a pasted draft');
    assert.equal(await page.locator('#submit-button').isEnabled(), true);
    await audit(s);
    const encrypted = (await stored(page))[VAULT_STORAGE_KEY];
    await access(page); await page.locator('#disconnect-button').click();
    await disconnected(page);
    await page.reload();
    await disconnected(page); await access(page);
    assert.equal(await page.locator('#token-field').isVisible(), false);
    assert.equal(await page.locator('#password-confirm-field').isVisible(), false);
    assert.equal(await page.locator('#connect-button-label').textContent(), 'Log in');
    const apiCount = mock.requests.length;
    await unlock(page, `${USERNAME} wrong`, PASSWORD);
    await page.waitForFunction(() => document.querySelector('#connection-message')?.dataset.state === 'error' && !document.querySelector('#connect-button')?.disabled);
    assert.equal(mock.requests.length, apiCount, 'Wrong username must fail locally without an API call');
    await unlock(page, USERNAME, `${PASSWORD} wrong`);
    await page.waitForFunction(() => document.querySelector('#connection-message')?.dataset.state === 'error' && !document.querySelector('#connect-button')?.disabled);
    assert.equal(mock.requests.length, apiCount, 'Wrong password must fail locally without an API call');
    await unlock(page); await connected(page);
    assert.equal((await stored(page))[VAULT_STORAGE_KEY], encrypted, 'A login must not persist the supplied strings or rewrite the vault');
    await page.locator('#close-connect').click();
    const other = await context.newPage(); await other.goto(origin);
    await other.evaluate(key => localStorage.removeItem(key), VAULT_STORAGE_KEY);
    await page.bringToFront();
    await disconnected(page);
    assert.equal(await page.locator('#connection-status').textContent(), 'Setup required');
    await audit(s, { expectVault: false });
  });

  await check('native-hold-navigation-and-copy-guards', async () => {
    const s = await session(); const { page } = s;
    await page.evaluate(() => {
      window.__qaKeys = [];
      document.addEventListener('keydown', event => {
        window.__qaKeys.push({ key: event.key, repeat: event.repeat, prevented: event.defaultPrevented });
      });
      window.__qaCopies = [];
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = value => {
        window.__qaCopies.push(value);
        return write(value);
      };
    });
    const selectedTheme = () => page.locator('#theme-select').inputValue();
    const selectedVariation = () => page.locator('#variation-select').inputValue();
    const focusReader = () => page.locator('.prompt-reading-area').focus();
    const hold = async (key, strokes) => {
      for (let index = 0; index < strokes; index++) await page.keyboard.down(key);
      await page.keyboard.up(key);
    };
    await page.locator('#theme-select').selectOption(catalog[0].id);
    await focusReader();
    await hold('d', catalog.length + 3);
    assert.equal(await selectedTheme(), catalog[3].id, 'Held D must continue through a complete theme loop');
    const observed = await page.evaluate(() => window.__qaKeys.splice(0));
    assert.equal(observed[0].repeat, false);
    assert.equal(observed.slice(1).every(event => event.key === 'd' && event.repeat && event.prevented), true,
      'Repeated keyboard.down calls must produce real repeat events handled by the app');
    await hold('a', catalog.length + 4);
    assert.equal(await selectedTheme(), catalog.at(-1).id, 'Held A must wrap backwards through the first theme');
    const variations = catalog.at(-1).variations;
    await hold('w', variations.length + 1);
    assert.equal(await selectedVariation(), variations.at(-1).id, 'Held W must wrap backwards through variations');
    await hold('s', variations.length + 1);
    assert.equal(await selectedVariation(), variations[0].id, 'Held S must wrap forward through variations');
    const stopped = await page.locator('#selection-count').textContent();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#selection-count').textContent(), stopped, 'No movement may continue after keyup');

    await page.keyboard.down('d');
    assert.equal(await selectedTheme(), catalog[0].id);
    await page.locator('#theme-search').focus();
    await page.keyboard.down('d'); // Still physically held: this repeat belongs to the input.
    assert.equal(await page.locator('#theme-search').inputValue(), 'd');
    assert.equal(await selectedTheme(), catalog[0].id, 'A repeated letter in search must type without navigating');
    await focusReader();
    await page.keyboard.down('d');
    assert.equal(await selectedTheme(), catalog[0].id, 'Returning from an input must require a fresh navigation press');
    await page.keyboard.up('d');
    await page.locator('#theme-search').fill('');
    await page.keyboard.type('adwsqe');
    assert.equal(await page.locator('#theme-search').inputValue(), 'adwsqe');
    assert.equal(await selectedTheme(), catalog[0].id, 'All shortcut letters must remain ordinary search input');
    await page.locator('#theme-search').fill('');

    await focusReader();
    await page.keyboard.down('d');
    assert.equal(await selectedTheme(), catalog[1].id);
    await page.locator('#open-shortcuts').click();
    await page.keyboard.down('d');
    assert.equal(await selectedTheme(), catalog[1].id, 'An open dialog must interrupt held navigation');
    await page.locator('#close-shortcuts').click();
    await focusReader();
    await page.keyboard.down('d');
    assert.equal(await selectedTheme(), catalog[1].id, 'Closing the dialog must not revive an interrupted hold');
    await page.keyboard.up('d');
    await page.keyboard.press('d');
    assert.equal(await selectedTheme(), catalog[2].id);

    await page.keyboard.down('a');
    assert.equal(await selectedTheme(), catalog[1].id);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.down('a');
    assert.equal(await selectedTheme(), catalog[1].id, 'Window blur must invalidate a held navigation key');
    await page.keyboard.up('a');

    await page.keyboard.press('Escape');
    await hold('q', 9);
    assert.deepEqual(await page.evaluate(() => window.__qaCopies), [`2. ${catalog[1].name}`],
      'Holding Q must copy the numbered theme once');
    await page.keyboard.press('Escape');
    await page.keyboard.press('q'); await page.keyboard.press('q');
    assert.deepEqual(await page.evaluate(() => window.__qaCopies.slice(-2)), [`2. ${catalog[1].name}`, catalog[1].name]);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), catalog[1].name);
    const copiesBeforeE = await page.evaluate(() => window.__qaCopies.length);
    await hold('e', 9);
    assert.equal(await page.evaluate(() => window.__qaCopies.length), copiesBeforeE + 1, 'Holding E must copy the prompt once');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), catalog[1].variations[0].prompt);
    await audit(s, { expectVault: false });
  });

  await check('file-draft-and-accepted-import', async () => {
    const s = await session(); const { page, mock } = s;
    await page.locator('#tab-import').click(); await page.locator('#mode-file').click();
    await page.locator('#json-file').setInputFiles([
      { name: '10-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([fixtureTheme(10)])) },
      { name: '2-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([fixtureTheme(2)])) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll('#file-list li').length === 2 && !document.querySelector('#validate-button')?.disabled);
    const filenames = await page.locator('#file-list li').allTextContents();
    assert.ok(filenames[0].includes('2-fixture.json')); assert.ok(filenames[1].includes('10-fixture.json'));
    await page.locator('#validate-button').click(); await configure(page); await page.locator('#close-connect').click();
    assert.deepEqual(await page.locator('#file-list li').allTextContents(), filenames);
    assert.equal(await page.locator('#json-file').evaluate(input => input.files.length), 2);
    assert.equal(await page.locator('#submit-button').isEnabled(), true);
    const blob = mock.hold('POST', `${repoPath}/git/blobs`);
    const dispatch = mock.hold('POST', `${workflowPath}/dispatches`);
    await page.locator('#submit-button').click(); await bounded(blob.entered, 'blob staging');
    assert.equal(await page.locator('#submission-status').getAttribute('data-state'), 'uploading');
    assert.equal(await page.locator('#safe-to-close').getAttribute('data-safe'), 'false');
    assert.equal(mock.requests.filter(call => call.pathname.endsWith('/dispatches')).length, 0);
    blob.release(); await bounded(dispatch.entered, 'workflow dispatch');
    assert.equal(await page.locator('#submission-status').getAttribute('data-state'), 'submitting');
    assert.equal(await page.locator('#safe-to-close').getAttribute('data-safe'), 'false');
    const staged = [...mock.blobs.values()][0];
    assert.deepEqual(JSON.parse(staged).map(theme => theme.id), ['qa-browser-theme-2', 'qa-browser-theme-10']);
    await audit(s);
    dispatch.release(); await bounded(dispatch.finished, 'dispatch response');
    await page.waitForFunction(() => document.querySelector('#safe-to-close')?.dataset.safe === 'true');
    assert.match(await page.locator('#submission-title').textContent(), /Accepted/);
    assert.equal(await page.locator('#submit-button').isDisabled(), true, 'Accepted input cannot be immediately submitted a second time');
    assert.equal(mock.requests.filter(call => call.pathname.endsWith('/dispatches')).length, 1);
    await audit(s); await screenshot(page, 'desktop-accepted-import.png');
  });

  await check('three-hundred-theme-large-file-batch', async () => {
    const s = await session(); const { page, mock } = s;
    const syntheticPrompt = 'Browser QA synthetic prompt text, used only for import capacity verification. '.repeat(100);
    const largeThemes = Array.from({ length: 300 }, (_, index) => {
      const number = index + 1;
      return { id: `qa-browser-theme-large-${number}`, name: `Capacity verification theme ${number}`,
        variations: Array.from({ length: 8 }, (_, variation) => ({
          id: `qa-browser-variation-large-${number}-${variation + 1}`,
          name: `Capacity verification variation ${variation + 1}`,
          prompt: syntheticPrompt,
        })) };
    });
    const files = largeThemes.map((theme, index) => ({
      name: `${index + 1}-capacity-fixture.json`, mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([theme])),
    })).reverse();
    const sourceBytes = files.reduce((bytes, file) => bytes + file.buffer.length, 0);
    assert.ok(sourceBytes > 16 * 1024 * 1024, 'The fixture must exceed both retired 5 MiB and 16 MiB limits');
    assert.ok(sourceBytes < 100_000_000);
    await configure(page); await page.locator('#close-connect').click();
    await page.locator('#tab-import').click(); await page.locator('#mode-file').click();
    await page.locator('#json-file').setInputFiles(files);
    await page.waitForFunction(() => document.querySelectorAll('#file-list li').length === 300 &&
      !document.querySelector('#validate-button')?.disabled, undefined, { timeout: 30000 });
    const filenames = await page.locator('#file-list li').allTextContents();
    assert.ok(filenames[0].includes('1-capacity-fixture.json'));
    assert.ok(filenames[1].includes('2-capacity-fixture.json'));
    assert.ok(filenames.at(-1).includes('300-capacity-fixture.json'));
    await page.locator('#validate-button').click();
    await page.waitForFunction(() => !document.querySelector('#submit-button')?.disabled, undefined, { timeout: 30000 });
    const preview = await page.locator('#validation-output').textContent();
    assert.match(preview, /300/);
    assert.match(preview, /2[,.]?400/);
    assert.match(preview, /ready to append/i);
    const blob = mock.hold('POST', `${repoPath}/git/blobs`);
    const dispatch = mock.hold('POST', `${workflowPath}/dispatches`);
    await page.locator('#submit-button').click(); await bounded(blob.entered, 'large blob staging');
    assert.equal(await page.locator('#safe-to-close').getAttribute('data-safe'), 'false');
    blob.release(); await bounded(dispatch.entered, 'large import dispatch');
    assert.equal(await page.locator('#safe-to-close').getAttribute('data-safe'), 'false');
    const staged = [...mock.blobs.values()][0];
    assert.ok(Buffer.byteLength(staged) > 16 * 1024 * 1024);
    const uploaded = JSON.parse(staged);
    assert.equal(uploaded.length, 300);
    assert.equal(uploaded.reduce((count, theme) => count + theme.variations.length, 0), 2400);
    assert.deepEqual(uploaded.map(theme => theme.id), largeThemes.map(theme => theme.id), 'The large payload must preserve natural filename order');
    dispatch.release(); await bounded(dispatch.finished, 'large import acceptance');
    await page.waitForFunction(() => document.querySelector('#safe-to-close')?.dataset.safe === 'true');
    assert.match(await page.locator('#submission-title').textContent(), /Accepted/);
    assert.equal(mock.requests.filter(call => call.pathname.endsWith('/dispatches')).length, 1);
    assert.equal(mock.runs[0].status, 'queued', 'Safe to close must not require the queued Action to finish');
    await audit(s);
    console.log(`Large import fixture: ${uploaded.length} themes, 2400 prompts, 300 files, ${sourceBytes.toLocaleString('en-US')} UTF-8 bytes.`);
  });

  await check('cancel-verification-before-save', async () => {
    const s = await session(); const { page, mock } = s;
    const verification = mock.hold('GET', '/user');
    await access(page);
    await page.locator('#access-token').fill(TOKEN); await page.locator('#access-username').fill(USERNAME);
    await page.locator('#access-password').fill(PASSWORD); await page.locator('#access-password-confirm').fill(PASSWORD);
    await page.locator('#connect-button').click(); await bounded(verification.entered, 'owner verification');
    verification.cancelled = true;
    await page.locator('#close-connect').click(); await disconnected(page);
    verification.release(); await bounded(verification.finished, 'cancelled verification response');
    await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
    assert.equal(await page.locator('#connection-status').textContent(), 'Setup required');
    assert.equal(mock.requests.filter(call => call.method === 'POST').length, 0);
    assert.equal(mock.requests.filter(call => call.pathname === repoPath || call.pathname === workflowPath).length, 0);
    await audit(s, { expectVault: false });
  });

  await check('unknown-dispatch-and-recovery', async () => {
    const s = await session(); const { page, mock } = s;
    await configure(page); await page.locator('#close-connect').click();
    await page.locator('#tab-import').click();
    await page.locator('#json-input').fill(JSON.stringify([fixtureTheme(20)]));
    await page.locator('#validate-button').click();
    mock.dispatchMode = 'unknown'; mock.showRuns = false;
    await page.locator('#submit-button').click();
    await page.waitForFunction(() => document.querySelector('#submission-status')?.dataset.state === 'unknown');
    assert.equal(await page.locator('#safe-to-close').getAttribute('data-safe'), 'false');
    assert.match(await page.locator('#safe-to-close').textContent(), /Acceptance unknown/);
    assert.equal(mock.requests.filter(call => call.pathname.endsWith('/dispatches')).length, 1);
    mock.showRuns = true;
    await page.locator('#tab-activity').click(); await page.locator('#refresh-activity').click();
    await page.waitForFunction(() => document.querySelector('#safe-to-close')?.dataset.safe === 'true');
    assert.equal(mock.requests.filter(call => call.pathname.endsWith('/dispatches')).length, 1, 'Finding the original run must not redispatch');
    assert.match(await page.locator('#activity-list').textContent(), /Safe to close/);
    await audit(s);
  });

  await check('mobile-owner-dialog', async () => {
    const s = await session({ width: 390, height: 844 }, true); const { page } = s;
    const controlsVisible = async position => {
      const controls = await page.evaluate(() => ['close-connect', 'connect-button'].map(id => {
        const button = document.getElementById(id);
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { id, insideViewport: bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 &&
          bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
          unobscured: hit === button || button.contains(hit) };
      }));
      for (const control of controls) {
        assert.ok(control.insideViewport, `${control.id} must remain fully inside the mobile viewport ${position}`);
        assert.ok(control.unobscured, `${control.id} must remain unobscured ${position}`);
      }
    };
    const scrollBody = async bottom => {
      await page.locator('.owner-dialog-body').evaluate((body, toBottom) => {
        body.scrollTop = toBottom ? body.scrollHeight : 0;
      }, bottom);
      await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(resolvePromise)));
    };
    await access(page); await scrollBody(false); await controlsVisible('at setup top');
    await screenshot(page, 'mobile-setup-top.png');
    const dimensions = await page.evaluate(() => {
      const dialog = document.querySelector('#connect-dialog');
      const bounds = dialog.getBoundingClientRect();
      return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        dialogWidth: dialog.scrollWidth, dialogClient: dialog.clientWidth,
        left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, height: innerHeight };
    });
    assert.ok(dimensions.pageWidth <= dimensions.viewport + 1, 'Mobile page must not scroll horizontally');
    assert.ok(dimensions.dialogWidth <= dimensions.dialogClient + 1, 'Mobile dialog must not scroll horizontally');
    assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.viewport + 1 && dimensions.top >= 0 && dimensions.bottom <= dimensions.height + 1);
    await scrollBody(true);
    assert.ok(await page.locator('.owner-dialog-body').evaluate(body => body.scrollTop > 0), 'The long setup form must actually scroll');
    await controlsVisible('after scrolling setup to bottom');
    await screenshot(page, 'mobile-setup-bottom.png');
    await page.locator('#access-token').fill(TOKEN); await page.locator('#access-username').fill(USERNAME);
    await page.locator('#access-password').fill(PASSWORD); await page.locator('#access-password-confirm').fill(PASSWORD);
    await page.locator('#access-password').scrollIntoViewIfNeeded();
    await controlsVisible('while setup fields are in view'); await screenshot(page, 'mobile-setup-fields.png');
    await page.locator('#connect-button').click(); await connected(page);
    await page.locator('#disconnect-button').click(); await disconnected(page);
    assert.equal(await page.locator('#token-field').isVisible(), false);
    await scrollBody(false); await controlsVisible('at login top');
    await screenshot(page, 'mobile-login.png');
    await scrollBody(true); await controlsVisible('after scrolling login to bottom');
    await screenshot(page, 'mobile-login-bottom.png');
    await unlock(page); await connected(page); await audit(s);
  });

  const failures = results.filter(result => !result.passed);
  console.log(`${results.length - failures.length}/${results.length} browser scenarios passed. Screenshots: ${qaDirectory}`);
  if (failures.length) process.exitCode = 1;
} finally {
  for (const context of contexts) {
    contextMocks.get(context)?.close();
    await context.close().catch(() => {});
  }
  await browser?.close();
  await new Promise(resolvePromise => server.close(resolvePromise));
}
