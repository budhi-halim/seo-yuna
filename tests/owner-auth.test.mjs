import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { AuthService, AuthError, seal, open, sha256, randomToken, validateAppConfig, getAppConfig,
  SESSION_COOKIE, OAUTH_COOKIE, OAUTH_CALLBACK_PATH, authErrorResponse } from '../owner/auth.mjs';
import { OWNER, OWNER_ID, REPOSITORY, REPOSITORY_ID, BRANCH, API_VERSION } from '../owner/github-app.mjs';

const clock = Date.parse('2026-10-18T12:00:00Z');
const origin = 'https://owner.example';
const key = Buffer.alloc(32, 17).toString('base64');
const otherKey = Buffer.alloc(32, 39).toString('base64');
const appConfig = { appId: 123456, clientId: 'Iv1.fixture-client-id', clientSecret: 'fixture-client-secret',
  privateKey: 'fixture-private-key-data-'.repeat(40), slug: 'seo-yuna-owner-test', installationId: 987654 };
const accessToken = 'ghu_fixture_owner_user_token';
const refreshToken = 'ghr_fixture_discarded_refresh_token';
const repo = { id: REPOSITORY_ID, full_name: REPOSITORY, default_branch: BRANCH,
  owner: { id: OWNER_ID, login: OWNER }, permissions: { push: true } };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const clone = value => structuredClone(value);
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const firstCookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0];

/** Real SQLite verifies the SQL and atomic DELETE RETURNING behavior behind a D1-shaped adapter. */
class TestD1 {
  sqlite = new DatabaseSync(':memory:');
  failure = null;
  queries = [];
  constructor() {
    this.sqlite.exec(`
      CREATE TABLE app_config (id TEXT PRIMARY KEY CHECK(id='github_app'), payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE sessions (session_hash TEXT PRIMARY KEY, payload TEXT NOT NULL, owner_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
      CREATE INDEX sessions_expiry ON sessions(expires_at);
    `);
  }
  prepare(sql) {
    const database = this;
    let values = [];
    const run = method => {
      if (database.failure) throw new Error(database.failure);
      database.queries.push({ sql, values });
      return database.sqlite.prepare(sql)[method](...values);
    };
    return {
      bind(...bindings) { values = bindings; return this; },
      async first() { return run('get') ?? null; },
      async run() { const result = run('run'); return { success: true, meta: { changes: result.changes } }; },
    };
  }
  rows(table) { return this.sqlite.prepare(`SELECT * FROM ${table}`).all(); }
}

async function fixture({ config = appConfig, tokenResult, user, repository, timeoutMs } = {}) {
  const db = new TestD1();
  const env = { DB: db, APP_CREDENTIAL_KEY: key, APP_ORIGIN: origin };
  if (config) db.sqlite.prepare("INSERT INTO app_config VALUES ('github_app', ?, ?)")
    .run(await seal(config, key, 'app-config', webcrypto), clock);
  const state = { now: clock, user: user ?? { id: OWNER_ID, login: OWNER }, repo: repository ?? clone(repo),
    tokenResult: tokenResult ?? { access_token: accessToken, refresh_token: refreshToken,
      expires_in: 28800, token_type: 'bearer' }, userStatus: 200, intercept: null };
  const calls = [];
  const fetchImpl = async function (url, init) {
    assert.equal(this, globalThis, 'Native fetch must retain its global receiver');
    calls.push({ url, init });
    const intercepted = state.intercept && await state.intercept(url, init);
    if (intercepted !== null && intercepted !== undefined) return intercepted;
    if (url === 'https://github.com/login/oauth/access_token') return json(state.tokenResult);
    if (url === 'https://api.github.com/user') return json(state.user, state.userStatus);
    if (url === `https://api.github.com/repos/${REPOSITORY}`) return json(state.repo);
    assert.fail('Unexpected GitHub destination');
  };
  const service = () => new AuthService({ env, fetchImpl, cryptoImpl: webcrypto, now: () => state.now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const begin = async (headers = {}) => {
    const response = await service().login(request('/api/owner/auth/login?return_to=https://attacker.example', { headers }));
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    return { response, location, state: location.searchParams.get('state'), cookie: firstCookie(response, OAUTH_COOKIE) };
  };
  const callback = (started, { state: callbackState = started.state, cookie = started.cookie, code = 'valid-code', extra = '' } = {}) =>
    service().callback(request(`${OAUTH_CALLBACK_PATH}?state=${callbackState}&code=${code}${extra}`, { headers: { cookie } }));
  const signIn = async () => {
    const started = await begin();
    const response = await callback(started);
    assert.equal(response.status, 302);
    const sessionCookie = firstCookie(response, SESSION_COOKIE);
    assert.ok(sessionCookie);
    const sessionResponse = await service().handleSession(request('/api/owner/session', { headers: { cookie: sessionCookie } }));
    const session = await sessionResponse.json();
    return { started, response, cookie: sessionCookie, session, sessionResponse };
  };
  return { db, env, state, calls, service, begin, callback, signIn };
}

test('AES-GCM envelopes authenticate purpose, use fresh IVs, and keep keys nonextractable', async () => {
  let imported;
  const cryptoImpl = { getRandomValues: value => webcrypto.getRandomValues(value), subtle: {
    importKey: async (...args) => { imported = await webcrypto.subtle.importKey(...args); return imported; },
    encrypt: (...args) => webcrypto.subtle.encrypt(...args), decrypt: (...args) => webcrypto.subtle.decrypt(...args),
  } };
  const value = { token: accessToken, verifier: 'a'.repeat(43) };
  const first = await seal(value, key, 'oauth-state:test', cryptoImpl);
  const second = await seal(value, key, 'oauth-state:test', cryptoImpl);
  assert.notEqual(first, second);
  assert.equal(imported.extractable, false);
  assert.deepEqual(await open(first, key, 'oauth-state:test', cryptoImpl), value);
  assert.ok(!first.includes(accessToken));
  await assert.rejects(open(first, key, 'session:test', cryptoImpl), AuthError);
  await assert.rejects(open(first, otherKey, 'oauth-state:test', cryptoImpl), AuthError);
  const changed = JSON.parse(first);
  changed.ciphertext = (changed.ciphertext[0] === 'A' ? 'B' : 'A') + changed.ciphertext.slice(1);
  await assert.rejects(open(JSON.stringify(changed), key, 'oauth-state:test', cryptoImpl), AuthError);
});

test('malformed crypto formats and oversized records are rejected before key import', async t => {
  const valid = JSON.parse(await seal({ token: accessToken }, key, 'app-config', webcrypto));
  const variants = [
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, extra: 'field' }),
    JSON.stringify({ ...valid, iv: 'AAAA' }), JSON.stringify({ ...valid, ciphertext: 'AAAA' }),
    'x'.repeat(96 * 1024 + 1), 'not-json',
  ];
  for (let index = 0; index < variants.length; index += 1) await t.test(String(index), async () => {
    let imports = 0;
    await assert.rejects(open(variants[index], key, 'app-config', {
      subtle: { importKey() { imports += 1; throw new Error('private key details'); } },
    }), error => error instanceof AuthError && !error.message.includes('private key details'));
    assert.equal(imports, 0);
  });
  await assert.rejects(seal({ text: 'あ'.repeat(30000) }, key, 'app-config', webcrypto), AuthError);
  await assert.rejects(seal({ text: 'small' }, 'not-a-key', 'app-config', webcrypto), AuthError);
  await assert.rejects(seal({ text: 'small' }, key, 'invalid/purpose', webcrypto), AuthError);
});

test('random references and SHA-256 have the required entropy and stable encoding', async () => {
  const first = randomToken(webcrypto);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, randomToken(webcrypto));
  assert.equal(await sha256('abc', webcrypto), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.throws(() => randomToken(webcrypto, 1), AuthError);
});

test('configuration is decrypted only on the server and validates completed-installation identity', async () => {
  const f = await fixture();
  assert.deepEqual(await getAppConfig(f.env, { cryptoImpl: webcrypto }), appConfig);
  assert.ok(!JSON.stringify(f.db.rows('app_config')).includes(appConfig.clientSecret));
  assert.equal(validateAppConfig({ ...appConfig, installationId: null }).installationId, null);
  const metadata = { appId: appConfig.appId, installationId: appConfig.installationId, slug: appConfig.slug,
    ownerId: OWNER_ID, owner: OWNER, repositoryId: REPOSITORY_ID, repository: REPOSITORY };
  assert.deepEqual(validateAppConfig({ ...appConfig, installationMetadata: metadata }).installationMetadata, metadata);
  assert.throws(() => validateAppConfig({ ...appConfig, extra: 'unknown' }), AuthError);
  assert.throws(() => validateAppConfig({ ...appConfig, installationMetadata: { ...metadata, ownerId: 1 } }), AuthError);
});

test('anonymous public status cannot be authorized by other identity or bearer headers', async () => {
  const f = await fixture({ config: null });
  const response = await f.service().handleSession(request('/api/owner/session', { headers: {
    'oai-authenticated-user-id': String(OWNER_ID), 'oai-authenticated-user-email': 'owner@example.com',
    Authorization: `Bearer ${accessToken}`, 'X-GitHub-User': OWNER,
  } }));
  assert.deepEqual(await response.json(), { authorized: false, configured: false, installationReady: false,
    login: null, csrfToken: null, expiresAt: null });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(f.calls.length, 0);
});

test('login uses state, PKCE S256, a fixed callback, and a secure browser binding cookie', async () => {
  const f = await fixture();
  const started = await f.begin();
  assert.equal(started.location.origin, 'https://github.com');
  assert.equal(started.location.pathname, '/login/oauth/authorize');
  assert.equal(started.location.searchParams.get('client_id'), appConfig.clientId);
  assert.equal(started.location.searchParams.get('redirect_uri'), `${origin}${OAUTH_CALLBACK_PATH}`);
  assert.equal(started.location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(started.location.searchParams.get('login'), OWNER);
  assert.ok(!started.location.href.includes('attacker') && !started.location.href.includes(appConfig.clientSecret));
  const header = started.response.headers.getSetCookie()[0];
  for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) assert.ok(header.includes(flag));
  assert.ok(!header.includes('Domain='));
  const rows = f.db.rows('oauth_states');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state_hash, await sha256(started.state, webcrypto));
  const saved = await open(rows[0].payload, key, `oauth-state:${rows[0].state_hash}`, webcrypto);
  const challenge = Buffer.from(await sha256(saved.verifier, webcrypto), 'hex').toString('base64url');
  assert.equal(started.location.searchParams.get('code_challenge'), challenge);
  assert.ok(!JSON.stringify(rows).includes(started.state) && !JSON.stringify(rows).includes(saved.verifier));
  assert.equal(f.calls.length, 0);
});

test('unfinished installation cannot start user OAuth and is represented accurately in status', async () => {
  const f = await fixture({ config: { ...appConfig, installationId: null } });
  const status = await f.service().handleSession(request('/api/owner/session'));
  const value = await status.json();
  assert.equal(value.configured, true);
  assert.equal(value.installationReady, false);
  assert.equal((await f.service().login(request('/api/owner/auth/login'))).status, 503);
  assert.equal(f.db.rows('oauth_states').length, 0);
});

test('callback exchanges the code server-side and creates an encrypted owner session', async () => {
  const f = await fixture();
  const signed = await f.signIn();
  assert.equal(signed.response.headers.get('location'), `${origin}/studio#import`);
  const exchange = f.calls[0];
  assert.equal(exchange.url, 'https://github.com/login/oauth/access_token');
  const body = JSON.parse(exchange.init.body);
  assert.equal(body.client_id, appConfig.clientId);
  assert.equal(body.client_secret, appConfig.clientSecret);
  assert.equal(body.repository_id, String(REPOSITORY_ID));
  assert.equal(body.redirect_uri, `${origin}${OAUTH_CALLBACK_PATH}`);
  assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.calls.slice(1).map(call => call.url), ['https://api.github.com/user', `https://api.github.com/repos/${REPOSITORY}`]);
  for (const call of f.calls) {
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.ok(!call.url.includes(appConfig.clientSecret) && !call.url.includes(accessToken));
  }
  assert.equal(f.calls[1].init.headers.Authorization, `Bearer ${accessToken}`);
  const row = f.db.rows('sessions')[0];
  const rawId = signed.cookie.split('=')[1];
  assert.equal(row.session_hash, await sha256(rawId, webcrypto));
  const saved = await open(row.payload, key, `session:${row.session_hash}`, webcrypto);
  assert.equal(saved.token, accessToken);
  assert.equal(saved.user.id, OWNER_ID);
  assert.equal(saved.csrfToken, signed.session.csrfToken);
  const stored = JSON.stringify([...f.db.rows('sessions'), ...f.db.rows('oauth_states')]);
  for (const secret of [rawId, accessToken, refreshToken, signed.session.csrfToken]) assert.ok(!stored.includes(secret));
  assert.equal(f.db.rows('oauth_states').length, 0);
  const responseText = JSON.stringify(signed.session) + JSON.stringify(Array.from(signed.response.headers));
  for (const secret of [accessToken, refreshToken, appConfig.clientSecret, appConfig.privateKey]) assert.ok(!responseText.includes(secret));
  assert.deepEqual(Object.keys(f.service()), []);
  assert.equal(signed.session.authorized, true);
  assert.equal(signed.session.login, OWNER);
  assert.equal(signed.session.installationReady, true);
});

test('callback state is browser-bound, unique, and consumed atomically on concurrent replay', async () => {
  const f = await fixture();
  const started = await f.begin();
  const mismatch = await f.callback(started, { cookie: `${OAUTH_COOKIE}=${'x'.repeat(43)}` });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.headers.get('set-cookie'), null);
  assert.equal(f.db.rows('oauth_states').length, 1);
  assert.equal(f.calls.length, 0);
  const duplicated = await f.callback(started, { extra: `&state=${started.state}` });
  assert.equal(duplicated.status, 403);
  const [one, two] = await Promise.all([f.callback(started), f.callback(started)]);
  assert.deepEqual([one.status, two.status].sort(), [302, 400]);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access_token')).length, 1);
  assert.equal(f.db.rows('sessions').length, 1);
  assert.equal(f.db.rows('oauth_states').length, 0);
});

test('expired or wrong-purpose states cannot exchange an OAuth code', async t => {
  for (const mode of ['expired', 'setup']) await t.test(mode, async () => {
    const f = await fixture();
    const started = await f.begin();
    if (mode === 'expired') f.state.now += 10 * 60000 + 1;
    else f.db.sqlite.prepare("UPDATE oauth_states SET kind='setup'").run();
    assert.equal((await f.callback(started)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal(f.db.rows('sessions').length, 0);
  });
});

test('login replacement invalidates its prior browser state and cleans expired rows in bounded batches', async () => {
  const f = await fixture();
  const started = await f.begin();
  for (let index = 0; index < 105; index += 1) {
    f.db.sqlite.prepare("INSERT INTO oauth_states VALUES (?, 'oauth', 'old', ?)").run(`old-${index}`, clock - 1);
    f.db.sqlite.prepare("INSERT INTO sessions VALUES (?, 'old', ?, ?)").run(`old-${index}`, OWNER_ID, clock - 1);
  }
  await f.begin({ cookie: started.cookie });
  assert.equal(f.db.rows('oauth_states').length, 6);
  assert.equal(f.db.rows('sessions').length, 5);
  assert.equal((await f.callback(started)).status, 400);
});

test('another GitHub user cannot establish a session even when the login name matches', async t => {
  for (const user of [{ id: 7, login: OWNER }, { id: OWNER_ID, login: 'other-owner' }]) await t.test(user.login + user.id, async () => {
    const f = await fixture({ user });
    assert.equal((await f.callback(await f.begin())).status, 403);
    assert.equal(f.db.rows('sessions').length, 0);
    assert.ok(!f.calls.some(call => call.url.includes('/repos/')));
  });
});

test('wrong repository ID, owner, branch, or write permission prevents a session', async t => {
  const variants = [
    { ...clone(repo), id: 7 }, { ...clone(repo), owner: { id: 8, login: OWNER } },
    { ...clone(repo), full_name: `${OWNER}/sakura-yuki` }, { ...clone(repo), default_branch: 'main' },
    { ...clone(repo), permissions: { push: false } },
  ];
  for (let index = 0; index < variants.length; index += 1) await t.test(String(index), async () => {
    const f = await fixture({ repository: variants[index] });
    assert.equal((await f.callback(await f.begin())).status, 403);
    assert.equal(f.db.rows('sessions').length, 0);
  });
});

test('installation tokens and malformed OAuth responses are never accepted as user sessions', async t => {
  const variants = [
    { access_token: 'ghs_installation_token', token_type: 'bearer' },
    { access_token: accessToken, token_type: 'basic' },
    { access_token: accessToken, token_type: 'bearer', expires_in: 0 },
    { access_token: accessToken, token_type: 'bearer', expires_in: 'forever' },
    { error: '<script>private-secret</script>', error_description: appConfig.clientSecret },
  ];
  for (let index = 0; index < variants.length; index += 1) await t.test(String(index), async () => {
    const f = await fixture({ tokenResult: variants[index] });
    const response = await f.callback(await f.begin());
    assert.ok(response.status >= 400);
    const text = await response.text();
    assert.ok(!text.includes('<script>') && !text.includes(appConfig.clientSecret));
    assert.equal(f.db.rows('sessions').length, 0);
    assert.equal(f.calls.length, 1);
  });
});

test('session cookies have host-only secure flags and expire by eight hours or earlier token expiration', async t => {
  for (const expiresIn of [undefined, 3600, 28800, 86400]) await t.test(String(expiresIn), async () => {
    const f = await fixture({ tokenResult: { access_token: accessToken, token_type: 'bearer', expires_in: expiresIn } });
    const signed = await f.signIn();
    const header = signed.response.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE}=`));
    for (const flag of ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Lax']) assert.ok(header.includes(flag));
    assert.ok(!header.includes('Domain='));
    assert.ok(Number(header.match(/Max-Age=(\d+)/)[1]) <= Math.min(expiresIn ?? 28800, 28800));
    const expiresAt = Date.parse(signed.session.expiresAt);
    assert.ok(expiresAt <= clock + Math.min(expiresIn ?? 28800, 28800) * 1000);
    f.state.now = expiresAt + 1;
    const response = await f.service().handleSession(request('/api/owner/session', { headers: { cookie: signed.cookie } }));
    assert.equal((await response.json()).authorized, false);
    assert.equal(f.db.rows('sessions').length, 0);
  });
});

test('write authentication requires the exact Origin and session-bound CSRF token before checking GitHub', async () => {
  const f = await fixture();
  const signed = await f.signIn();
  const callsBefore = f.calls.length;
  const headers = { cookie: signed.cookie, origin, 'x-csrf-token': signed.session.csrfToken };
  for (const bad of [{ ...headers, origin: 'https://attacker.example' }, { cookie: signed.cookie },
    { ...headers, 'x-csrf-token': 'x'.repeat(43) }]) {
    await assert.rejects(f.service().authenticate(request('/api/owner/import', { method: 'POST', headers: bad }), { write: true }),
      error => error instanceof AuthError && error.status === 403);
  }
  await assert.rejects(f.service().authenticate(request('/api/owner/import', { headers }), { write: true }),
    error => error.status === 405);
  assert.equal(f.calls.length, callsBefore);
  const authorized = await f.service().authenticate(request('/api/owner/import', { method: 'POST', headers }), { write: true });
  assert.equal(authorized.token, accessToken);
  assert.deepEqual(authorized.user, { id: OWNER_ID, login: OWNER });
  assert.equal(f.calls.length, callsBefore + 1);
  assert.equal(f.calls.at(-1).url, 'https://api.github.com/user');
});

test('revoked GitHub authorization blocks writes and deletes the local session', async () => {
  const f = await fixture();
  const signed = await f.signIn();
  f.state.userStatus = 401;
  f.state.user = { message: 'secret upstream error', token: accessToken };
  await assert.rejects(f.service().authenticate(request('/api/owner/import', { method: 'POST', headers: {
    cookie: signed.cookie, origin, 'x-csrf-token': signed.session.csrfToken,
  } }), { write: true }), error => error.status === 401 && !error.message.includes('secret'));
  assert.equal(f.db.rows('sessions').length, 0);
});

test('temporary GitHub failures do not erase a valid session or retry the account check', async () => {
  const f = await fixture();
  const signed = await f.signIn();
  f.state.userStatus = 503;
  const before = f.calls.length;
  let authenticationFailure;
  await assert.rejects(f.service().authenticate(request('/api/owner/import', { method: 'POST', headers: {
    cookie: signed.cookie, origin, 'x-csrf-token': signed.session.csrfToken,
  } }), { write: true }), error => {
    authenticationFailure = error;
    return error instanceof AuthError && error.status === 502;
  });
  const response = authErrorResponse(authenticationFailure);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).uncertain, false);
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.db.rows('sessions').length, 1);
});

test('session database tampering cannot change owner, extend expiration, or move ciphertext to another cookie', async t => {
  for (const mode of ['owner', 'expiration', 'moved']) await t.test(mode, async () => {
    const f = await fixture();
    const signed = await f.signIn();
    let sessionCookie = signed.cookie;
    if (mode === 'owner') f.db.sqlite.prepare('UPDATE sessions SET owner_id=7').run();
    if (mode === 'expiration') f.db.sqlite.prepare('UPDATE sessions SET expires_at=expires_at+3600000').run();
    if (mode === 'moved') {
      const differentId = randomToken(webcrypto);
      sessionCookie = `${SESSION_COOKIE}=${differentId}`;
      f.db.sqlite.prepare('UPDATE sessions SET session_hash=?').run(await sha256(differentId, webcrypto));
    }
    const response = await f.service().handleSession(request('/api/owner/session', { headers: { cookie: sessionCookie } }));
    assert.equal((await response.json()).authorized, false);
    assert.equal(f.db.rows('sessions').length, 0);
  });
});

test('logout requires CSRF, invalidates the server session, and works without GitHub availability', async () => {
  const f = await fixture();
  const signed = await f.signIn();
  const bad = await f.service().logout(request('/api/owner/auth/logout', { method: 'POST', headers: { cookie: signed.cookie, origin } }));
  assert.equal(bad.status, 403);
  assert.equal(f.db.rows('sessions').length, 1);
  const callsBefore = f.calls.length;
  f.state.intercept = () => { throw new Error('GitHub offline with sensitive details'); };
  const response = await f.service().logout(request('/api/owner/auth/logout', { method: 'POST', headers: {
    cookie: signed.cookie, origin, 'x-csrf-token': signed.session.csrfToken,
  } }));
  assert.deepEqual(await response.json(), { authorized: false });
  assert.equal(f.calls.length, callsBefore);
  assert.equal(f.db.rows('sessions').length, 0);
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.ok(response.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
  await assert.rejects(f.service().authenticate(request('/api/owner/import', { headers: { cookie: signed.cookie } })),
    error => error.status === 401);
});

test('a new successful login rotates the cookie and invalidates the old session', async () => {
  const f = await fixture();
  const old = await f.signIn();
  const started = await f.begin({ cookie: old.cookie });
  const response = await f.callback(started, { cookie: `${started.cookie}; ${old.cookie}` });
  const freshCookie = firstCookie(response, SESSION_COOKIE);
  assert.notEqual(freshCookie, old.cookie);
  assert.equal(f.db.rows('sessions').length, 1);
  await assert.rejects(f.service().authenticate(request('/api/owner/import', { headers: { cookie: old.cookie } })),
    error => error.status === 401);
});

test('cancellation and errors never echo GitHub query strings or private upstream details', async () => {
  const f = await fixture();
  const started = await f.begin();
  const cancelled = await f.callback(started, { extra: '&error=access_denied&error_description=private-secret' });
  assert.equal(cancelled.headers.get('location'), `${origin}/studio?auth=cancelled#import`);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.rows('oauth_states').length, 0);
  const unknown = authErrorResponse(new Error('private database credentials'));
  const unknownBody = await unknown.json();
  assert.ok(!JSON.stringify(unknownBody).includes('private database credentials'));
  assert.equal(unknownBody.uncertain, false);
  f.db.failure = 'private database credentials';
  const failure = await f.service().handleSession(request('/api/owner/session'));
  assert.equal(failure.status, 503);
  assert.ok(!(await failure.text()).includes('private database credentials'));
});

test('OAuth exchange timeout aborts once, consumes state, and returns a sanitized error', async () => {
  const f = await fixture({ timeoutMs: 10 });
  f.state.intercept = (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true });
  });
  const response = await f.callback(await f.begin());
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('private timeout'));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true);
  assert.equal(f.db.rows('oauth_states').length, 0);
  assert.equal(f.db.rows('sessions').length, 0);
});
