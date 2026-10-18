import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SetupService, handleSetup, createManifest, SETUP_PATH, SETUP_CALLBACK_PATH,
  SETUP_INSTALL_PATH, SETUP_COOKIE, INSTALL_COOKIE, SETUP_TTL } from '../owner/setup.mjs';
import { getAppConfig, open, seal, sha256 } from '../owner/auth.mjs';
import { GitHubError, OWNER, OWNER_ID, REPOSITORY, REPOSITORY_ID,
  BRANCH, API_VERSION } from '../owner/github-app.mjs';

const origin = 'https://seo-yuna-owner.example';
const clock = Date.parse('2026-10-18T12:00:00Z');
const code = 'test_conversion_code_1234567890';
const appId = 987654;
const installationId = 765432;
const slug = 'seo-yuna-private-test';
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const conversion = { id: appId, slug, owner: { id: OWNER_ID, login: OWNER, type: 'User' },
  permissions: { contents: 'write', actions: 'write', metadata: 'read' }, events: [],
  client_id: 'Iv1.0123456789abcdef', client_secret: 'abcdef0123456789'.repeat(3), pem: privateKey,
  external_url: `https://${OWNER}.github.io/seo-yuna/`, html_url: `https://github.com/apps/${slug}`,
  webhook_secret: 'unused-webhook-secret-never-saved',
};
const config = { appId, slug, clientId: conversion.client_id, clientSecret: conversion.client_secret,
  privateKey: privateKey.trim(), installationId: null };
const metadata = { appId, installationId, slug, ownerId: OWNER_ID, owner: OWNER,
  repositoryId: REPOSITORY_ID, repository: REPOSITORY };
const repository = { id: REPOSITORY_ID, full_name: REPOSITORY, default_branch: BRANCH,
  owner: { id: OWNER_ID, login: OWNER } };
const installation = { id: installationId, app_id: appId, app_slug: slug,
  account: { id: OWNER_ID, login: OWNER, type: 'User' }, target_id: OWNER_ID, target_type: 'User',
  permissions: { contents: 'write', actions: 'write', metadata: 'read' },
  repository_selection: 'selected', suspended_at: null, suspended_by: null };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const copy = value => structuredClone(value);

/** A D1-shaped adapter over real in-memory SQLite, including atomic RETURNING/INSERT OR IGNORE. */
function database(t) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE app_config (id TEXT PRIMARY KEY CHECK(id='github_app'), payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE sessions (session_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, owner_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
  t.after(() => raw.close());
  return { raw, prepare(sql) {
    return { bind(...bindings) {
      return {
        async first() { return raw.prepare(sql).get(...bindings) ?? null; },
        async run() {
          const result = raw.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    } };
  } };
}

function fixture(t, { converted = conversion, conversionResponse, installationResponse = installation,
  tokenChanges = {}, githubClientFactory, fetchOverride, appOrigin = origin, timeoutMs } = {}) {
  const db = database(t);
  const env = { DB: db, APP_ORIGIN: appOrigin, APP_CREDENTIAL_KEY: randomBytes(32).toString('base64') };
  const calls = [];
  const diagnostics = [];
  t.mock.method(console, 'warn', (...args) => diagnostics.push(args));
  let instant = clock;
  const fetchImpl = async function (url, init) {
    assert.equal(this, globalThis, 'Native fetch must retain its global receiver');
    if (init.redirect !== undefined && !['follow', 'manual'].includes(init.redirect)) {
      throw new TypeError('Workerd requires redirect to be follow or manual');
    }
    calls.push({ url, init });
    const overridden = fetchOverride && await fetchOverride(url, init);
    if (overridden !== undefined) return overridden;
    if (url.includes('/app-manifests/')) return conversionResponse ? conversionResponse() : json(copy(converted), 201);
    if (url.endsWith('/installation')) return json(copy(installationResponse));
    if (url.includes('/app/installations?')) return json([copy(installationResponse)]);
    if (url.endsWith('/access_tokens')) return json({ token: 'ghs_test_installation_token_never_in_a_response',
      expires_at: new Date(instant + 3600000).toISOString(),
      permissions: { contents: 'write', actions: 'write', metadata: 'read' },
      repository_selection: 'selected', repositories: [copy(repository)], ...copy(tokenChanges) }, 201);
    throw new Error('An unexpected external route was requested by the test.');
  };
  const options = { fetchImpl, cryptoImpl: webcrypto, now: () => instant,
    ...(githubClientFactory ? { githubClientFactory } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  const service = new SetupService(env, options);
  return { db, env, calls, diagnostics, service, options, now: () => instant, advance(ms) { instant += ms; } };
}

function post(path, { requestOrigin = origin, urlOrigin = origin, body } = {}) {
  const headers = {};
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  return new Request(`${urlOrigin}${path}`, { method: 'POST', headers, body });
}

function cookieFrom(response, name) {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0] ?? '';
}

async function begin(f) {
  const response = await f.service.handle(post(SETUP_PATH));
  const html = await response.text();
  assert.equal(response.status, 200);
  const token = html.match(/settings\/apps\/new\?state=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(token);
  return { response, html, token, cookie: cookieFrom(response, SETUP_COOKIE) };
}

function callback(start, extra = {}) {
  const url = new URL(`${origin}${SETUP_CALLBACK_PATH}`);
  url.searchParams.set('state', start.token);
  url.searchParams.set('code', code);
  for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
  return new Request(url, { headers: { Cookie: start.cookie } });
}

async function register(f) {
  const start = await begin(f);
  const response = await f.service.handle(callback(start));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('Location'));
  return { start, response, token: location.searchParams.get('state'),
    cookie: cookieFrom(response, INSTALL_COOKIE), location };
}

function installCallback(registration, extra = {}) {
  const url = new URL(`${origin}${SETUP_INSTALL_PATH}`);
  for (const [name, value] of Object.entries({ state: registration.token,
    installation_id: String(installationId), setup_action: 'install', ...extra })) url.searchParams.set(name, value);
  return new Request(url, { headers: { Cookie: registration.cookie } });
}

const configCount = f => f.db.raw.prepare('SELECT count(*) AS count FROM app_config').get().count;
const stateCount = f => f.db.raw.prepare('SELECT count(*) AS count FROM oauth_states').get().count;
const conversionCalls = f => f.calls.filter(call => call.url.includes('/app-manifests/'));
const readConfig = f => getAppConfig(f.env, { cryptoImpl: webcrypto });
const diagnosticDetails = f => f.diagnostics.map(args => {
  assert.equal(args.length, 1);
  return JSON.parse(args[0]);
});
const manifestFrom = html => JSON.parse(html.match(/name="manifest" value="([^"]+)"/)[1]
  .replace(/&(quot|amp|lt|gt|#39);/g, entity => ({ '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" })[entity]));

test('the manifest pins private ownership scope, callbacks, inactive hooks, and minimum permissions', () => {
  const manifest = createManifest(origin);
  assert.deepEqual(manifest, {
    name: 'SeoYunaBudhiHalim', url: `https://${OWNER}.github.io/seo-yuna/`, public: false,
    redirect_url: `${origin}${SETUP_CALLBACK_PATH}`, callback_urls: [`${origin}/api/owner/oauth/callback`],
    setup_url: `${origin}${SETUP_INSTALL_PATH}`, request_oauth_on_install: false, setup_on_update: false,
    hook_attributes: { url: `${origin}/api/owner/webhook`, active: false },
    default_permissions: { contents: 'write', actions: 'write' }, default_events: [],
  });
  for (const invalid of ['http://example.com', `${origin}/`, `${origin}/path`, `${origin}?a=1`,
    'https://user:password@example.com', 'https://example.com/\"><script>']) {
    assert.throws(() => createManifest(invalid), /address is unavailable/);
  }
});

test('setup is a same-origin POST and request body parameters cannot change the manifest', async t => {
  const f = fixture(t);
  for (const requestOrigin of [null, 'null', 'https://wrong.example', `${origin}.wrong.example`, `${origin}/`]) {
    const response = await f.service.handle(post(SETUP_PATH, { requestOrigin }));
    assert.equal(response.status, 403);
  }
  assert.equal((await f.service.handle(post(SETUP_PATH, { urlOrigin: 'https://wrong.example' }))).status, 403);
  assert.equal((await f.service.handle(new Request(`${origin}${SETUP_PATH}`))).status, 405);
  assert.equal(await handleSetup(new Request(`${origin}/somewhere-else`)), null);
  assert.equal(stateCount(f), 0);
  assert.equal(f.calls.length, 0);
  const response = await f.service.handle(post(SETUP_PATH, { body: 'owner=attacker&repo=sakura-yuki&public=true' }));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes('attacker') && !body.includes('sakura-yuki'));
  assert.ok(body.includes('&quot;public&quot;:false'));
});

test('fresh registrations propose distinct valid names while preserving fixed callbacks and permissions', async t => {
  const f = fixture(t);
  const first = await begin(f);
  const second = await begin(f);
  const manifests = [manifestFrom(first.html), manifestFrom(second.html)];
  assert.notEqual(manifests[0].name, manifests[1].name);
  for (const manifest of manifests) {
    assert.match(manifest.name, /^SeoYunaBudhiHalim-[a-f0-9]{8}$/);
    assert.deepEqual({ ...manifest, name: 'SeoYunaBudhiHalim' }, createManifest(origin));
    assert.ok(!manifest.name.includes(first.token) && !manifest.name.includes(second.token));
  }
  assert.equal(configCount(f), 0);
  assert.equal(f.calls.length, 0);
});

test('registration state is random, hashed, encrypted, bound to this site, and expires after ten minutes', async t => {
  const f = fixture(t);
  const start = await begin(f);
  const row = f.db.raw.prepare('SELECT * FROM oauth_states').get();
  assert.equal(row.kind, 'setup');
  assert.equal(row.state_hash, await sha256(start.token, webcrypto));
  assert.notEqual(row.state_hash, start.token);
  assert.equal(row.expires_at, clock + SETUP_TTL);
  assert.ok(!row.payload.includes(start.token) && !row.payload.includes(origin));
  const state = await open(row.payload, f.env.APP_CREDENTIAL_KEY, `setup-state:${row.state_hash}`, webcrypto);
  assert.deepEqual(state, { version: 1, origin, ownerId: OWNER_ID, repositoryId: REPOSITORY_ID,
    appId: null, createdAt: clock, expiresAt: clock + SETUP_TTL });
  const cookies = start.response.headers.getSetCookie().join('\n');
  for (const attribute of ['Path=/', 'Max-Age=600', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(cookies.includes(attribute));
  assert.ok(!cookies.includes('Domain='));
  assert.ok(start.response.headers.get('Cache-Control').includes('no-store'));
  assert.equal(start.response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.ok(start.response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  assert.ok(!start.html.includes('<script') && !start.html.includes(privateKey));
});

test('conversion verifies the fixed owner and stores only encrypted normalized credentials', async t => {
  const f = fixture(t);
  const registration = await register(f);
  assert.deepEqual(await readConfig(f), config);
  assert.equal(configCount(f), 1);
  assert.equal(conversionCalls(f).length, 1);
  const row = f.db.raw.prepare('SELECT * FROM app_config').get();
  for (const secret of [conversion.pem, conversion.client_secret, conversion.webhook_secret]) assert.ok(!row.payload.includes(secret));
  assert.equal(registration.location.origin, 'https://github.com');
  assert.equal(registration.location.pathname, `/apps/${slug}/installations/new`);
  assert.match(registration.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(registration.response.headers.getSetCookie().some(value => value.startsWith(`${SETUP_COOKIE}=;`) && value.includes('Max-Age=0')));
  assert.equal(await registration.response.text(), '');
  const call = conversionCalls(f)[0];
  assert.equal(call.url, `https://api.github.com/app-manifests/${code}/conversions`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.cache, 'no-store');
  assert.ok(call.init.signal instanceof AbortSignal);
  const installRow = f.db.raw.prepare('SELECT * FROM oauth_states').get();
  assert.equal(installRow.kind, 'setup-install');
  const installState = await open(installRow.payload, f.env.APP_CREDENTIAL_KEY, `setup-install:${installRow.state_hash}`, webcrypto);
  assert.equal(installState.appId, appId);
});

test('another account can never claim bootstrap, and its consumed callback cannot replay', async t => {
  for (const owner of [{ ...conversion.owner, id: 1 }, { ...conversion.owner, login: 'attacker' },
    { ...conversion.owner, type: 'Organization' }, null]) await t.test(JSON.stringify(owner), async st => {
    const f = fixture(st, { converted: { ...copy(conversion), owner } });
    const start = await begin(f);
    const response = await f.service.handle(callback(start));
    assert.equal(response.status, 403);
    assert.equal(configCount(f), 0);
    assert.equal((await f.service.handle(callback(start))).status, 400);
    assert.equal(conversionCalls(f).length, 1);
    assert.ok(!(await response.text()).includes(conversion.client_secret));
  });
});

test('changed permissions, explicit public visibility, and malformed conversion fields fail before persistence', async t => {
  const cases = [
    ['public', { public: true }], ['ambiguous visibility', { public: null }],
    ['extra permission', { permissions: { ...conversion.permissions, administration: 'write' } }],
    ['missing permission', { permissions: { contents: 'write' } }],
    ['webhook event', { events: ['push'] }], ['string app ID', { id: String(appId) }],
    ['unsafe app ID', { id: Number.MAX_SAFE_INTEGER + 1 }],
    ['slug injection', { slug: 'other-app/../../bad' }], ['client ID injection', { client_id: 'bad\r\nX-Token: other' }],
    ['short secret', { client_secret: 'short' }], ['wrong PEM', { pem: 'not-a-key'.repeat(100) }],
    ['invalid RSA material', { pem: `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(1024)}\n-----END RSA PRIVATE KEY-----\n` }],
    ['wrong app URL', { html_url: 'https://attacker.example/apps/fake' }],
    ['wrong homepage', { external_url: 'https://attacker.example/' }],
  ];
  for (const [name, changes] of cases) await t.test(name, async st => {
    const f = fixture(st, { converted: { ...copy(conversion), ...changes } });
    const response = await f.service.handle(callback(await begin(f)));
    assert.ok([403, 502].includes(response.status));
    assert.equal(configCount(f), 0);
    const text = await response.text();
    assert.ok(!text.includes('attacker.example') && !text.includes('PRIVATE KEY') && !text.includes(conversion.client_secret));
  });
  await t.test('GitHub’s documented omission of public is accepted, as is explicit false', async st => {
    const f = fixture(st, { converted: { ...copy(conversion), public: false } });
    await register(f);
    assert.equal(configCount(f), 1);
  });
});

test('mismatched, missing, duplicate, expired, and replayed state cannot reach GitHub', async t => {
  const f = fixture(t);
  const start = await begin(f);
  const attempts = [
    new Request(callback(start).url),
    new Request(callback(start).url, { headers: { Cookie: `${SETUP_COOKIE}=${'A'.repeat(43)}` } }),
    new Request(callback(start).url, { headers: { Cookie: `${start.cookie}; ${start.cookie}` } }),
    new Request(`${callback(start).url}&state=${start.token}`, { headers: { Cookie: start.cookie } }),
    new Request(`${origin}${SETUP_CALLBACK_PATH}?code=${code}`, { headers: { Cookie: start.cookie } }),
  ];
  for (const request of attempts) assert.equal((await f.service.handle(request)).status, 400);
  assert.equal(conversionCalls(f).length, 0);
  f.advance(SETUP_TTL);
  assert.equal((await f.service.handle(callback(start))).status, 400);
  assert.equal(conversionCalls(f).length, 0);
  const next = await begin(f);
  assert.equal((await f.service.handle(callback(next))).status, 303);
  assert.equal((await f.service.handle(callback(next))).status, 400);
  assert.equal(conversionCalls(f).length, 1);
});

test('database expiration changes cannot extend or alter an authenticated setup state', async t => {
  for (const advance of [0, SETUP_TTL + 1]) await t.test(`clock advanced ${advance}`, async st => {
    const f = fixture(st);
    const start = await begin(f);
    f.advance(advance);
    f.db.raw.prepare('UPDATE oauth_states SET expires_at = ?').run(f.now() + SETUP_TTL + 1);
    assert.equal((await f.service.handle(callback(start))).status, 400);
    assert.equal(conversionCalls(f).length, 0);
    assert.equal(configCount(f), 0);
  });
});

test('public setup cleanup has a fixed row bound and leaves OAuth states to their own service', async t => {
  const f = fixture(t);
  const insert = f.db.raw.prepare('INSERT INTO oauth_states (state_hash, kind, payload, expires_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 250; i += 1) {
    insert.run(`expired-setup-${i}`, 'setup', 'expired', clock - 1);
    insert.run(`expired-oauth-${i}`, 'oauth', 'expired', clock - 1);
  }
  await begin(f);
  assert.equal(f.db.raw.prepare("SELECT count(*) AS count FROM oauth_states WHERE kind = 'setup' AND expires_at < ?").get(clock).count, 150);
  assert.equal(f.db.raw.prepare("SELECT count(*) AS count FROM oauth_states WHERE kind = 'oauth'").get().count, 250);
});

test('concurrent callbacks consume state once and the singleton can never be overwritten', async t => {
  await t.test('same state', async st => {
    const f = fixture(st);
    const start = await begin(f);
    const responses = await Promise.all([f.service.handle(callback(start)), f.service.handle(callback(start))]);
    assert.deepEqual(responses.map(response => response.status).sort(), [303, 400]);
    assert.equal(conversionCalls(f).length, 1);
    assert.equal(configCount(f), 1);
  });
  await t.test('two separately valid states race to register different apps', async st => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let arrived = 0;
    const f = fixture(st, { fetchOverride: async url => {
      if (!url.includes('/app-manifests/')) return undefined;
      const sequence = ++arrived;
      if (arrived === 2) release();
      await gate;
      return json({ ...copy(conversion), id: appId + sequence, slug: `${slug}-${sequence}`,
        html_url: `https://github.com/apps/${slug}-${sequence}` }, 201);
    } });
    const first = await begin(f);
    const second = await begin(f);
    const responses = await Promise.all([f.service.handle(callback(first)), f.service.handle(callback(second))]);
    assert.deepEqual(responses.map(response => response.status).sort(), [303, 409]);
    assert.equal(configCount(f), 1);
    const original = f.db.raw.prepare('SELECT payload FROM app_config').get().payload;
    assert.equal((await f.service.handle(post(SETUP_PATH))).status, 409);
    assert.equal(f.db.raw.prepare('SELECT payload FROM app_config').get().payload, original);
    assert.equal(conversionCalls(f).length, 2);
  });
});

test('conversion uses Workerd-compatible manual redirects and rejects a 302 without following its destination', async t => {
  const destination = `https://attacker.example/${code}?secret=${conversion.client_secret}`;
  const f = fixture(t, { conversionResponse: () => new Response('private upstream body', {
    status: 302, headers: { Location: destination },
  }) });
  const response = await f.service.handle(callback(await begin(f)));
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.match(body, /data-error-code="conversion_http_failed"/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.ok(!f.calls.some(call => call.url === destination));
  assert.equal(response.headers.get('Location'), null);
  assert.equal(configCount(f), 0);
  assert.deepEqual(diagnosticDetails(f), [{ event: 'seo_yuna_setup_conversion_failure', phase: 'http', status: 302 }]);
  assert.ok(!body.includes(destination) && !body.includes('private upstream body') && !body.includes('<script'));
  assert.ok(response.headers.get('Content-Security-Policy').includes("default-src 'none'"));
  assert.ok(!response.headers.get('Content-Security-Policy').includes('unsafe-inline'));
});

test('HTTP conversion diagnostics include only a numeric status and a bounded GitHub request ID', async t => {
  for (const [name, requestId, expected] of [
    ['valid request ID', '012A:345B:678C:90DE:F123', '012A:345B:678C:90DE:F123'],
    ['credential-shaped value', conversion.client_secret, undefined],
    ['oversized value', 'ABCD:'.repeat(30), undefined],
  ]) await t.test(name, async st => {
    const f = fixture(st, { conversionResponse: () => new Response(JSON.stringify({
      message: code, token: conversion.client_secret, pem: privateKey,
    }), { status: 422, headers: { 'X-GitHub-Request-Id': requestId } }) });
    const response = await f.service.handle(callback(await begin(f)));
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.match(body, /data-error-code="conversion_http_failed"/);
    assert.match(body, /may already exist on GitHub/);
    assert.deepEqual(diagnosticDetails(f), [{ event: 'seo_yuna_setup_conversion_failure', phase: 'http', status: 422,
      ...(expected ? { githubRequestId: expected } : {}) }]);
    const displayed = body + JSON.stringify(f.diagnostics);
    for (const secret of [code, conversion.client_secret, privateKey, 'app-manifests/']) assert.ok(!displayed.includes(secret));
  });
});

test('transport errors have an allowlisted category without exposing exception details', async t => {
  for (const [name, error, category] of [
    ['ordinary error', new Error(`${code} ${conversion.client_secret} ${privateKey}`), 'Error'],
    ['runtime type error', new TypeError(`${code} ${conversion.client_secret}`), 'TypeError'],
    ['untrusted error name', Object.assign(new Error(code), { name: conversion.client_secret }), 'UnknownError'],
  ]) await t.test(name, async st => {
    const f = fixture(st, { fetchOverride: () => { throw error; } });
    const start = await begin(f);
    const response = await f.service.handle(callback(start));
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.match(body, /data-error-code="conversion_transport_failed"/);
    assert.deepEqual(diagnosticDetails(f), [{ event: 'seo_yuna_setup_conversion_failure', phase: 'transport', category }]);
    const displayed = body + JSON.stringify(f.diagnostics);
    for (const secret of [code, conversion.client_secret, privateKey, 'app-manifests/']) assert.ok(!displayed.includes(secret));
    assert.equal(configCount(f), 0);
    assert.equal((await f.service.handle(callback(start))).status, 400);
    assert.equal(f.calls.length, 1);
  });
});

test('conversion timeout aborts once and remains distinct from HTTP and transport failures', async t => {
  const f = fixture(t, { timeoutMs: 10, fetchOverride: (_, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException(`${code} ${conversion.client_secret}`, 'AbortError')), { once: true });
  }) });
  const start = await begin(f);
  const response = await f.service.handle(callback(start));
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.match(body, /data-error-code="conversion_timeout"/);
  assert.deepEqual(diagnosticDetails(f), [{ event: 'seo_yuna_setup_conversion_failure', phase: 'timeout', category: 'AbortError' }]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true);
  assert.equal(configCount(f), 0);
  assert.equal(stateCount(f), 0);
  assert.ok(!JSON.stringify(f.diagnostics).includes(code) && !body.includes(conversion.client_secret));
});

test('RSA import failure after a 201 has a separate safe category and preserves the existing persistence boundary', async t => {
  const f = fixture(t, { converted: { ...copy(conversion),
    pem: `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(1024)}\n-----END RSA PRIVATE KEY-----\n` } });
  const response = await f.service.handle(callback(await begin(f)));
  const body = await response.text();
  assert.equal(response.status, 502);
  assert.match(body, /data-error-code="conversion_key_invalid"/);
  assert.match(body, /do not create another app yet/);
  assert.deepEqual(diagnosticDetails(f), [{ event: 'seo_yuna_setup_conversion_failure', phase: 'key', category: 'GitHubError' }]);
  assert.equal(configCount(f), 0);
  assert.equal(f.calls.length, 1);
  const displayed = body + JSON.stringify(f.diagnostics);
  for (const secret of [code, conversion.client_secret, 'PRIVATE KEY', 'A'.repeat(100)]) assert.ok(!displayed.includes(secret));
});

test('conversion failures are bounded, sanitized, and never automatically retried', async t => {
  const responses = [
    ['upstream rejection', () => json({ message: `${code} ${conversion.client_secret}` }, 422)],
    ['redirect', () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } })],
    ['invalid JSON', () => new Response(`${code} ${conversion.client_secret}`, { status: 201 })],
    ['oversize stream', () => new Response('x'.repeat(65537), { status: 201 })],
    ['oversize length', () => new Response('{}', { status: 201, headers: { 'Content-Length': '65537' } })],
    ['bad UTF-8', () => new Response(new Uint8Array([0xff, 0xfe]), { status: 201 })],
    ['connection error', () => { throw new Error(`${code} ${conversion.client_secret} ${privateKey}`); }],
  ];
  for (const [name, conversionResponse] of responses) await t.test(name, async st => {
    const f = fixture(st, { conversionResponse });
    const start = await begin(f);
    const response = await f.service.handle(callback(start));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(code) && !text.includes(conversion.client_secret) && !text.includes('PRIVATE KEY') && !text.includes('app-manifests/'));
    assert.equal(configCount(f), 0);
    assert.equal(conversionCalls(f).length, 1);
    assert.equal((await f.service.handle(callback(start))).status, 400);
    assert.equal(conversionCalls(f).length, 1);
  });
});

test('the install callback verifies the real fixed-repository client before saving installation metadata', async t => {
  const f = fixture(t);
  const registered = await register(f);
  const response = await f.service.handle(installCallback(registered));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/studio#import');
  assert.deepEqual(await readConfig(f), { ...config, installationId, installationMetadata: metadata });
  assert.equal(f.db.raw.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
  assert.equal(stateCount(f), 0);
  const mint = f.calls.find(call => call.url.endsWith('/access_tokens'));
  assert.deepEqual(JSON.parse(mint.init.body), { repository_ids: [REPOSITORY_ID],
    permissions: { contents: 'write', actions: 'write' } });
  assert.ok(f.calls.some(call => call.url === `https://api.github.com/repos/${REPOSITORY}/installation`));
  assert.ok(!f.calls.some(call => call.url.includes('sakura-yuki') || call.url.endsWith('/git/blobs') || call.url.endsWith('/dispatches')));
  assert.equal((await f.service.handle(installCallback(registered))).status, 400);
});

test('installation query data never authorizes a wrong app, owner, repository, or broader token', async t => {
  const cases = [
    ['query installation ID', {}, { installation_id: String(installationId + 1) }],
    ['unsafe query ID', {}, { installation_id: '9007199254740992' }],
    ['incomplete action', {}, { setup_action: 'request' }],
    ['different owner', { installationResponse: { ...copy(installation), account: { id: 1, login: OWNER } } }, {}],
    ['different app', { installationResponse: { ...copy(installation), app_id: appId + 1 } }, {}],
    ['extra repository', { tokenChanges: { repositories: [copy(repository), { id: 1 }] } }, {}],
    ['old repository', { tokenChanges: { repositories: [{ ...copy(repository), full_name: `${OWNER}/sakura-yuki` }] } }, {}],
    ['broad token', { tokenChanges: { permissions: { ...installation.permissions, administration: 'write' } } }, {}],
  ];
  for (const [name, options, query] of cases) await t.test(name, async st => {
    const f = fixture(st, options);
    const registered = await register(f);
    const saved = f.db.raw.prepare('SELECT payload FROM app_config').get().payload;
    const response = await f.service.handle(installCallback(registered, query));
    assert.ok([400, 403].includes(response.status));
    assert.equal(f.db.raw.prepare('SELECT payload FROM app_config').get().payload, saved);
    assert.equal((await readConfig(f)).installationId, null);
  });
});

test('the setup and installation state cookies cannot be substituted for one another', async t => {
  const f = fixture(t);
  const start = await begin(f);
  const fakeRegistration = { token: start.token, cookie: `${INSTALL_COOKIE}=${start.token}` };
  assert.equal((await f.service.handle(installCallback(fakeRegistration))).status, 400);
  assert.equal((await f.service.handle(callback(start))).status, 303);
  assert.equal(conversionCalls(f).length, 1);
});

test('recovery verifies an already installed app after a lost callback without registering another app', async t => {
  const f = fixture(t);
  await register(f);
  f.advance(SETUP_TTL + 1);
  const response = await f.service.handle(post(SETUP_INSTALL_PATH));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/studio#import');
  assert.deepEqual(await readConfig(f), { ...config, installationId, installationMetadata: metadata });
  assert.equal(conversionCalls(f).length, 1);
  assert.equal((await f.service.handle(post(SETUP_PATH))).status, 409);
});

test('recovery resumes only the saved app when it is not yet installed and requires exact Origin', async t => {
  const f = fixture(t, { githubClientFactory: () => ({ async verifyInstallation() { throw new GitHubError('not installed', 404); } }) });
  const registered = await register(f);
  const saved = f.db.raw.prepare('SELECT payload FROM app_config').get().payload;
  assert.equal((await f.service.handle(post(SETUP_INSTALL_PATH, { requestOrigin: null }))).status, 403);
  assert.equal((await f.service.handle(post(SETUP_INSTALL_PATH, { requestOrigin: 'https://wrong.example' }))).status, 403);
  f.advance(SETUP_TTL + 1);
  assert.equal((await f.service.handle(installCallback(registered))).status, 400);
  const response = await f.service.handle(post(SETUP_INSTALL_PATH));
  const location = new URL(response.headers.get('Location'));
  assert.equal(response.status, 303);
  assert.equal(location.origin, 'https://github.com');
  assert.equal(location.pathname, `/apps/${slug}/installations/new`);
  assert.notEqual(location.searchParams.get('state'), registered.token);
  assert.equal(f.db.raw.prepare('SELECT payload FROM app_config').get().payload, saved);
  assert.equal(conversionCalls(f).length, 1);
});

test('an installation network failure does not silently mark setup ready', async t => {
  const f = fixture(t, { githubClientFactory: () => ({ async verifyInstallation() {
    throw new Error(`${conversion.client_secret} ${code}`);
  } }) });
  await register(f);
  const response = await f.service.handle(post(SETUP_INSTALL_PATH));
  assert.equal(response.status, 502);
  assert.equal((await readConfig(f)).installationId, null);
  const text = await response.text();
  assert.ok(!text.includes(conversion.client_secret) && !text.includes(code));
});

test('installation metadata cannot overwrite a concurrently changed credential record', async t => {
  let f;
  const replacement = { ...config, appId: appId + 1, slug: 'another-owner-created-app' };
  f = fixture(t, { githubClientFactory: () => ({ async verifyInstallation() {
    const payload = await seal(replacement, f.env.APP_CREDENTIAL_KEY, 'app-config', webcrypto);
    f.db.raw.prepare("UPDATE app_config SET payload = ? WHERE id = 'github_app'").run(payload);
    return copy(metadata);
  } }) });
  const registered = await register(f);
  const response = await f.service.handle(installCallback(registered));
  assert.equal(response.status, 409);
  assert.deepEqual(await readConfig(f), replacement);
});

test('database and encryption failures never expose raw provider errors or persist plaintext', async t => {
  await t.test('unusable encryption key', async st => {
    const f = fixture(st);
    f.env.APP_CREDENTIAL_KEY = 'invalid';
    const response = await f.service.handle(post(SETUP_PATH));
    assert.equal(response.status, 503);
    assert.equal(stateCount(f), 0);
    assert.equal(f.calls.length, 0);
  });
  await t.test('database exception', async st => {
    const f = fixture(st);
    f.env.DB = { prepare() { throw new Error(`${conversion.client_secret} ${code}`); } };
    const response = await f.service.handle(post(SETUP_PATH));
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.ok(!text.includes(conversion.client_secret) && !text.includes(code));
    assert.equal(f.calls.length, 0);
  });
});
