import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { OwnerClient, OwnerAccessError } from '../assets/owner-client.mjs';
import { CredentialVault, CredentialVaultError, VAULT_STORAGE_KEY } from '../assets/credential-vault.mjs';
import { OWNER, OWNER_ID, REPOSITORY_ID, WORKFLOW_PATH } from '../assets/github.mjs';

const token = `github_pat_${'A'.repeat(80)}`;
const secondToken = `github_pat_${'B'.repeat(80)}`;
const username = 'local tea cup';
const password = 'a local password of my own';
const receipt = { blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const user = { id: OWNER_ID, login: OWNER };
const repository = { id: REPOSITORY_ID, full_name: 'budhi-halim/seo-yuna', owner: user,
  default_branch: 'master', permissions: { push: true } };
const workflow = { id: 17, path: WORKFLOW_PATH, state: 'active' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', ...headers } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
function fakeVault({ configured = false, available = true, error = null, load, save, unlock, forget } = {}) {
  return { configured, available, error, saves: [], cancellations: 0,
    async load() { return load ? load.call(this) : { configured: this.configured, available: this.available }; },
    async save(...args) { this.saves.push(args); if (save) return save.apply(this, args); this.configured = true; },
    async unlock(...args) { if (unlock) return unlock.apply(this, args); return token; },
    cancel() { this.cancellations += 1; },
    forget() { if (forget) return forget.call(this); this.configured = false; this.error = null; },
  };
}
function fixture({ handler = () => undefined, vault, savedStorage = storage(), cryptoImpl = webcrypto, lifecycleTarget, timeoutMs, uploadTimeoutMs } = {}) {
  const calls = [];
  const fetchImpl = async function (url, init) {
    assert.equal(this, globalThis);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    calls.push({ url, init });
    const response = await handler(url, init);
    if (response !== undefined) return response;
    if (url.endsWith('/user')) return json(user);
    if (url === 'https://api.github.com/repos/budhi-halim/seo-yuna') return json(repository);
    if (url.endsWith('/actions/workflows/studio.yml')) return json(workflow);
    if (url.includes('/contents/data.json?')) return new Response('[]');
    if (url.endsWith('/git/blobs')) return json({ sha: receipt.blobSha }, 201);
    if (url.endsWith('/dispatches')) return json({ workflow_run_id: 42 });
    if (url.includes('/jobs?')) return json({ jobs: [] });
    if (url.includes('/studio.yml/runs?')) return json({ workflow_runs: [] });
    return json({ id: Number(new URL(url).pathname.split('/').at(-1)) });
  };
  return { client: new OwnerClient({ fetchImpl, storage: savedStorage, cryptoImpl, vault, lifecycleTarget,
    ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs }) }), calls, savedStorage };
}

test('initialization reads local state without probing any account or sending credentials', async () => {
  const { client, calls } = fixture();
  assert.equal(client.connected, false);
  assert.deepEqual(await client.initialize(), { configured: false, storageAvailable: true, storageError: '', connected: false, authorized: false, login: null });
  assert.equal(calls.length, 0);
  assert.deepEqual(Object.keys(client), []);
  assert.equal(JSON.stringify(client), '{}');
  assert.throws(() => { client.connected = true; }, TypeError);
  await assert.rejects(client.stageBlob('[]'), error => error instanceof OwnerAccessError && error.status === 401);
  await assert.rejects(client.dispatch(receipt), error => error.status === 401 && !error.uncertain);
  assert.equal(calls.length, 0);
});

test('real encrypted setup verifies GitHub first and the two strings never reach a network request', async () => {
  const savedStorage = storage();
  const { client, calls } = fixture({ savedStorage, handler: () => {
    assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), null, 'verification precedes persistence');
  } });
  await client.initialize();
  const result = await client.configure(username, password, token);
  assert.equal(result.connected, true);
  assert.equal(result.configured, true);
  assert.equal(result.login, OWNER);
  assert.equal(client.authorized, true);
  assert.equal(calls.length, 3);
  const encrypted = savedStorage.getItem(VAULT_STORAGE_KEY);
  assert.ok(encrypted);
  for (const secret of [username, password, token]) assert.equal(encrypted.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  for (const { url, init } of calls) {
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'manual');
    const request = JSON.stringify({ url, ...init });
    assert.equal(request.includes(username), false); assert.equal(request.includes(password), false);
    assert.equal(url.includes(token), false);
    assert.equal(init.body, undefined);
  }
  assert.deepEqual(Object.keys(client), []);
});

test('a new instance starts locked, unlock verifies the token again, and logout is entirely local', async () => {
  const savedStorage = storage();
  const vault = new CredentialVault({ storage: savedStorage, cryptoImpl: webcrypto });
  await vault.save(username, password, token);
  const encrypted = savedStorage.getItem(VAULT_STORAGE_KEY);
  const { client, calls } = fixture({ savedStorage });
  assert.equal(client.connected, false);
  await client.initialize();
  assert.equal(client.configured, true);
  assert.equal(client.connected, false);
  assert.equal(calls.length, 0);
  await client.unlock(username, password);
  assert.equal(calls.length, 3);
  assert.equal(client.connected, true);
  assert.equal(client.login, OWNER);
  assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), encrypted);
  const signedOut = client.logout();
  assert.equal(signedOut.connected, false);
  assert.equal(client.authorized, false);
  assert.equal(client.login, null);
  assert.equal(calls.length, 3, 'logout has no network request');
  assert.equal(client.configured, true);
  assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), encrypted);
  await client.readCanonical();
  assert.equal(calls.at(-1).init.headers.Authorization, undefined);
});

test('wrong local strings leave encrypted setup intact and make no GitHub request', async () => {
  const savedStorage = storage();
  await new CredentialVault({ storage: savedStorage, cryptoImpl: webcrypto }).save(username, password, token);
  const encrypted = savedStorage.getItem(VAULT_STORAGE_KEY);
  const { client, calls } = fixture({ savedStorage });
  await client.initialize();
  for (const pair of [[username.toUpperCase(), password], [username, `${password}!`]]) {
    await assert.rejects(client.unlock(...pair), error => error instanceof OwnerAccessError && error.status === 401 &&
      !error.message.includes(token) && !error.message.includes(pair[0]));
    assert.equal(client.connected, false);
    assert.equal(client.configured, true);
    assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), encrypted);
  }
  assert.equal(calls.length, 0);
});

for (const [name, path, value] of [['another owner', '/user', { ...user, id: 2, login: 'visitor' }],
  ['recreated repository', '/repos/budhi-halim/seo-yuna', { ...repository, id: 2 }],
  ['unconfirmed write access', '/repos/budhi-halim/seo-yuna', { ...repository, permissions: {} }],
  ['another workflow', '/actions/workflows/studio.yml', { ...workflow, path: '.github/workflows/other.yml' }]]) {
  test(`configure never persists a token for ${name}`, async () => {
    const vault = fakeVault();
    const { client } = fixture({ vault, handler: url => new URL(url).pathname.endsWith(path) ? json(value) : undefined });
    await assert.rejects(client.configure(username, password, token), OwnerAccessError);
    assert.equal(vault.saves.length, 0);
    assert.equal(client.connected, false);
    assert.equal(client.configured, false);
  });
}

test('local input and token validation reject invalid setup before network or persistence', async () => {
  const vault = fakeVault();
  const { client, calls } = fixture({ vault });
  for (const values of [['', password, token], [username, 'short', token], [username, password, 'ghp_broad'],
    [username, password, `${token}\n`], [username, 'a'.repeat(1025), token]]) {
    await assert.rejects(client.configure(...values), error => error instanceof OwnerAccessError && !error.uncertain);
  }
  assert.equal(calls.length, 0);
  assert.equal(vault.saves.length, 0);
});

test('storage failure after verification leaves the browser locked and does not erase old setup', async () => {
  const vault = fakeVault({ configured: true, save() { this.error = new CredentialVaultError('storage_unavailable'); throw this.error; } });
  const { client, calls } = fixture({ vault });
  await assert.rejects(client.configure(username, password, token), OwnerAccessError);
  assert.equal(calls.length, 3);
  assert.equal(client.configured, true);
  assert.equal(client.connected, false);
  assert.ok(client.storageError);
  await client.readCanonical();
  assert.equal(calls.at(-1).init.headers.Authorization, undefined);
});

test('an invalid or revoked decrypted token never becomes an active connection', async () => {
  for (const [unlocked, status] of [['ghp_broad', 200], [token, 401]]) {
    const vault = fakeVault({ configured: true, unlock: async () => unlocked });
    const { client, calls } = fixture({ vault, handler: url => url.endsWith('/user') ? json({ message: token }, status) : undefined });
    await assert.rejects(client.unlock(username, password), error => error instanceof OwnerAccessError && !error.message.includes(token));
    assert.equal(client.connected, false);
    assert.equal(client.configured, true);
    assert.equal(calls.length, status === 401 ? 1 : 0);
  }
});

test('late verification cannot save or reconnect after logout, even if fetch ignores cancellation', async () => {
  const waiting = deferred();
  const vault = fakeVault();
  const { client, calls } = fixture({ vault, handler: url => url.endsWith('/user') ? waiting.promise : undefined });
  const setup = client.configure(username, password, token);
  const rejected = assert.rejects(setup, /cancelled/);
  client.logout();
  await rejected;
  waiting.resolve(json(user));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.connected, false);
  assert.equal(vault.saves.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('late decryption cannot begin verification or reconnect after forget', async () => {
  const waiting = deferred();
  const vault = fakeVault({ configured: true, unlock: () => waiting.promise });
  const { client, calls } = fixture({ vault });
  const unlock = client.unlock(username, password);
  const rejected = assert.rejects(unlock, /cancelled/);
  client.forget();
  waiting.resolve(token);
  await rejected;
  assert.equal(client.connected, false);
  assert.equal(client.configured, false);
  assert.equal(calls.length, 0);
});

for (const action of ['logout', 'forget', 'pagehide']) {
  test(`${action} during real encryption prevents a stale encrypted save and connection`, async () => {
    const started = deferred();
    const release = deferred();
    const lifecycleTarget = new EventTarget();
    const cryptoImpl = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: {
      importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle), deriveKey: webcrypto.subtle.deriveKey.bind(webcrypto.subtle),
      decrypt: webcrypto.subtle.decrypt.bind(webcrypto.subtle), async encrypt(...args) {
        started.resolve(); await release.promise; return webcrypto.subtle.encrypt(...args);
      },
    } };
    const { client, savedStorage } = fixture({ cryptoImpl, lifecycleTarget });
    const setup = client.configure(username, password, token);
    const rejected = assert.rejects(setup, /cancelled/);
    await started.promise;
    if (action === 'pagehide') lifecycleTarget.dispatchEvent(new Event('pagehide')); else client[action]();
    release.resolve();
    await rejected;
    assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), null);
    assert.equal(client.connected, false);
    assert.equal(client.configured, false);
  });
}

test('an older login operation cannot overwrite or disconnect a newer connection', async () => {
  const waiting = deferred();
  const vault = fakeVault({ configured: true, unlock: () => waiting.promise });
  const { client, calls } = fixture({ vault });
  const old = client.unlock(username, password);
  const rejected = assert.rejects(old, /cancelled/);
  await client.configure(username, password, secondToken);
  waiting.resolve(token);
  await rejected;
  assert.equal(client.connected, true);
  assert.equal(vault.saves.length, 1);
  assert.equal(vault.saves[0][2], secondToken);
  assert.equal(calls.every(call => call.init.headers.Authorization === `Bearer ${secondToken}`), true);
});

test('a newer configure cancels older verification and only the newer token is saved', async () => {
  const waiting = deferred();
  const vault = fakeVault();
  const { client, calls } = fixture({ vault, handler: (url, init) =>
    url.endsWith('/user') && init.headers.Authorization === `Bearer ${token}` ? waiting.promise : undefined });
  const old = client.configure(username, password, token);
  const rejected = assert.rejects(old, /cancelled/);
  await client.configure(username, password, secondToken);
  await rejected;
  waiting.resolve(json({ message: 'old token failure' }, 403));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.connected, true);
  assert.equal(vault.saves.length, 1);
  assert.equal(vault.saves[0][2], secondToken);
  assert.equal(calls.length, 4);
});

test('network timeout during unlock fails closed and releases the candidate token', async () => {
  const vault = fakeVault({ configured: true });
  const { client, calls } = fixture({ vault, timeoutMs: 20, handler: url => url.endsWith('/user') ? new Promise(() => {}) : undefined });
  await assert.rejects(client.unlock(username, password), error => error instanceof OwnerAccessError && !error.uncertain);
  assert.equal(client.connected, false);
  assert.equal(calls[0].init.signal.aborted, true);
  await client.readCanonical();
  assert.equal(calls.at(-1).init.headers.Authorization, undefined);
});

test('all read methods remain available through anonymous GitHub while locked', async () => {
  const { client, calls } = fixture({ vault: fakeVault({ configured: true }) });
  await client.initialize();
  assert.equal(await client.readCanonical(), '[]');
  assert.equal((await client.readRun(9)).id, 9);
  assert.deepEqual(await client.readJobs(9), { jobs: [] });
  assert.equal(await client.findRun(receipt.requestId, '2026-10-18T00:00:00Z'), null);
  assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.method, 'GET');
  }
});

test('staging and dispatch preserve the existing receipt and work only while connected', async () => {
  const { client, calls } = fixture({ vault: fakeVault() });
  await client.configure(username, password, token);
  assert.equal(await client.stageBlob('[]'), receipt.blobSha);
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: 42 });
  const body = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(body, { ref: 'master', inputs: { payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest } });
  client.disconnect();
  const count = calls.length;
  await assert.rejects(client.dispatch(receipt), /local login/);
  assert.equal(calls.length, count);
});

test('unknown submission outcome stays uncertain and never reflects network secrets or repeats', async () => {
  let dispatched = 0;
  const { client } = fixture({ vault: fakeVault(), handler: url => { if (url.endsWith('/dispatches')) {
    dispatched += 1; throw new Error(`${username} ${password} ${token}`);
  } } });
  await client.configure(username, password, token);
  await assert.rejects(client.dispatch(receipt), error => error instanceof OwnerAccessError && error.uncertain &&
    [username, password, token].every(secret => !error.message.includes(secret)) && error.cause === undefined);
  assert.equal(dispatched, 1);
});

test('confirmed acceptance stays accepted if pagehide cancels reading optional run details', async () => {
  const reading = deferred();
  const lifecycleTarget = new EventTarget();
  const { client } = fixture({ vault: fakeVault(), lifecycleTarget, handler: url => url.endsWith('/dispatches') ?
    new Response(new ReadableStream({ pull() { reading.resolve(); } }, { highWaterMark: 0 }), { status: 200 }) : undefined });
  await client.configure(username, password, token);
  const result = client.dispatch(receipt);
  await reading.promise;
  lifecycleTarget.dispatchEvent(new Event('pagehide'));
  assert.deepEqual(await result, { accepted: true, runId: null });
  assert.equal(client.connected, false);
});

test('authorization failure clears local memory while rate-limit cooldown metadata is preserved', async () => {
  for (const [status, headers, staysConnected] of [[401, {}, false], [403, {}, false], [403, { 'Retry-After': '75' }, true]]) {
    const { client } = fixture({ vault: fakeVault(), handler: url => url.endsWith('/runs/9') ? json({ message: token }, status, headers) : undefined });
    await client.configure(username, password, token);
    await assert.rejects(client.readRun(9), error => error instanceof OwnerAccessError && error.status === status &&
      !error.message.includes(token) && (!staysConnected || error.retryAfterSeconds === 75));
    assert.equal(client.connected, staysConnected);
    assert.equal(client.configured, true);
  }
});

test('blocked or corrupt local storage does not block anonymous browsing', async () => {
  for (const savedStorage of [null, { getItem() { throw new Error(token); }, setItem() {}, removeItem() {} }, storage()]) {
    if (savedStorage?.values) savedStorage.values.set(VAULT_STORAGE_KEY, 'not valid encrypted data');
    const { client, calls } = fixture({ savedStorage });
    const state = await client.initialize();
    assert.equal(state.connected, false);
    assert.equal(state.configured, false);
    assert.ok(client.storageError);
    assert.equal(client.storageError.includes(token), false);
    assert.equal(calls.length, 0);
    assert.equal(await client.readCanonical(), '[]');
    assert.equal(calls[0].init.headers.Authorization, undefined);
  }
});

test('forget removes only local setup; a removal failure still locks immediately and is reported', async () => {
  const savedStorage = storage();
  const { client } = fixture({ savedStorage });
  await client.configure(username, password, token);
  savedStorage.setItem('unrelated', 'keep');
  assert.equal(client.forget().configured, false);
  assert.equal(savedStorage.getItem(VAULT_STORAGE_KEY), null);
  assert.equal(savedStorage.getItem('unrelated'), 'keep');
  assert.equal(client.connected, false);

  const badVault = fakeVault({ configured: true, forget() { this.error = new CredentialVaultError('storage_unavailable'); throw this.error; } });
  const failed = fixture({ vault: badVault });
  await failed.client.unlock(username, password);
  assert.equal(failed.client.connected, true);
  assert.throws(() => failed.client.forget(), OwnerAccessError);
  assert.equal(failed.client.connected, false);
  assert.equal(failed.client.configured, true);
  assert.ok(failed.client.storageError);
});
