import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createOwnerHandler, createServerGitHubFetch, readJSONText } from '../owner/api.mjs';
import { AuthError } from '../owner/auth.mjs';
import { GitHubError } from '../assets/github.mjs';

const origin = 'https://owner.example.test';
const source = JSON.stringify([{ id: 'sample', name: 'Sample', variations: [{ id: 'sample-one', name: 'One', prompt: 'Existing test fixture.' }] }]);
const sha = 'a'.repeat(40);
const digest = createHash('sha256').update(source).digest('hex');
const id = '12345678-1234-4123-8123-123456789abc';
const record = { requestId: id, blobSha: sha, digest };

function fixture({ owner = true, dispatchImpl, authFailure } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE staged_uploads (blob_sha TEXT PRIMARY KEY, digest TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE import_requests (request_id TEXT PRIMARY KEY, blob_sha TEXT NOT NULL, digest TEXT NOT NULL, owner_id INTEGER NOT NULL, state TEXT NOT NULL, run_id INTEGER, created_at INTEGER NOT NULL);`);
  const calls = [];
  const db = { prepare(sql) {
    return { bind(...args) {
      return {
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async run() { return sqlite.prepare(sql).run(...args); },
      };
    } };
  } };
  const client = {
    async readCanonical() { calls.push('read'); return source; },
    async stageBlob(value) { calls.push(['stage', value]); return sha; },
    async dispatch(value) { calls.push(['dispatch', value]); return dispatchImpl ? dispatchImpl(value) : { accepted: true, runId: 345 }; },
    async readRun(value) { calls.push(['run', value]); return { id: value, status: 'queued' }; },
    async readJobs(value) { calls.push(['jobs', value]); return { jobs: [] }; },
    async findRun(...values) { calls.push(['find', ...values]); return null; },
  };
  const handle = createOwnerHandler({ env: { DB: db, APP_ORIGIN: origin },
    setupHandler: async () => null,
    authFactory: () => ({
      async handleSession() { return Response.json({ authorized: false, configured: true }); },
      async authenticate(request, options) {
        calls.push(['auth', options.write]);
        if (authFailure) throw authFailure;
        if (options.write && (request.headers.get('Origin') !== origin || request.headers.get('X-CSRF-Token') !== 'test-csrf')) {
          throw new AuthError('The request could not be verified.', 403, 'csrf_failed');
        }
        return { user: { id: owner ? 121861881 : 2, login: owner ? 'budhi-halim' : 'outsider' }, token: 'server-only-fixture' };
      },
    }),
    githubClientFactory(token) { assert.equal(token, 'server-only-fixture'); return client; },
  });
  function request(path, body, headers = {}) {
    return new Request(origin + '/api/owner' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'X-CSRF-Token': 'test-csrf', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  }
  return { handle, request, calls, sqlite };
}

test('anonymous and wrong-owner callers cannot read or stage owner data', async () => {
  for (const options of [{ owner: false }, { authFailure: new AuthError('Sign in with GitHub.', 401, 'signed_out') }]) {
    const f = fixture(options);
    for (const request of [f.request('/catalog'), f.request('/stage', source)]) {
      const response = await f.handle(request);
      assert.ok([401, 403].includes(response.status));
      assert.ok(!f.calls.includes('read'));
    }
  }
});

test('write authentication runs before consuming or staging JSON', async () => {
  const f = fixture();
  const response = await f.handle(f.request('/stage', source, { 'X-CSRF-Token': '' }));
  assert.equal(response.status, 403);
  assert.deepEqual(f.calls, [['auth', true]]);
});

test('valid staging binds exact digest to the fixed owner without committing data', async () => {
  const f = fixture();
  const response = await f.handle(f.request('/stage', source));
  assert.deepEqual(await response.json(), { sha });
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
  assert.deepEqual({ ...f.sqlite.prepare('SELECT * FROM staged_uploads').get(), created_at: 0 },
    { blob_sha: sha, digest, owner_id: 121861881, created_at: 0 });
  assert.equal(f.calls.filter(value => Array.isArray(value) && value[0] === 'dispatch').length, 0);
});

test('invalid, empty, and conflicting batches never reach GitHub staging', async () => {
  for (const value of ['{bad', '[]', '[{"id":"empty","name":"Empty","variations":[]}]', source.replace('Existing test fixture.', 'Changed fixture.')]) {
    const f = fixture();
    const response = await f.handle(f.request('/stage', value));
    assert.equal(response.status, 422);
    assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'stage').length, 0);
  }
});

test('dispatch requires a matching server-validated digest', async () => {
  const f = fixture();
  assert.equal((await f.handle(f.request('/dispatch', record))).status, 409);
  await f.handle(f.request('/stage', source));
  assert.equal((await f.handle(f.request('/dispatch', { ...record, digest: 'f'.repeat(64) }))).status, 409);
  assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'dispatch').length, 0);
});

test('confirmed acceptance is safe and the same request is never dispatched twice', async () => {
  const f = fixture();
  await f.handle(f.request('/stage', source));
  const first = await f.handle(f.request('/dispatch', record));
  const second = await f.handle(f.request('/dispatch', record));
  assert.deepEqual(await first.json(), { accepted: true, runId: 345 });
  assert.deepEqual(await second.json(), { accepted: true, runId: 345 });
  assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'dispatch').length, 1);
});

test('ambiguous dispatch remains uncertain, with no replay on retrying its receipt', async () => {
  const f = fixture({ dispatchImpl: () => { throw new GitHubError('Connection interrupted.'); } });
  await f.handle(f.request('/stage', source));
  const first = await f.handle(f.request('/dispatch', record));
  const second = await f.handle(f.request('/dispatch', record));
  assert.equal((await first.json()).uncertain, true);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).uncertain, true);
  assert.equal(f.calls.filter(item => Array.isArray(item) && item[0] === 'dispatch').length, 1);
});

test('GitHub rejection does not claim the workflow was accepted', async () => {
  const f = fixture({ dispatchImpl: () => { throw new GitHubError('GitHub rejected the request.', 403); } });
  await f.handle(f.request('/stage', source));
  const response = await f.handle(f.request('/dispatch', record));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).uncertain, false);
  assert.equal(f.sqlite.prepare('SELECT state FROM import_requests').get().state, 'rejected');
});

test('fixed run routes reject arbitrary destinations, malformed IDs and query parameters', async () => {
  const f = fixture();
  assert.equal((await f.handle(f.request('/runs/345'))).status, 200);
  assert.equal((await f.handle(f.request('/runs/345/jobs'))).status, 200);
  assert.equal((await f.handle(f.request('/runs?request_id=' + id + '&created_at=2026-10-18T00%3A00%3A00Z'))).status, 200);
  for (const path of ['/repos/other/repo', '/runs/0', '/runs/9007199254740993', '/runs?request_id=' + id + '&created_at=bad', '/runs?url=https://evil.test']) {
    assert.ok([400, 404].includes((await f.handle(f.request(path))).status));
  }
  const wrongOrigin = new Request('https://evil.test/api/owner/catalog');
  assert.equal((await f.handle(wrongOrigin)).status, 403);
});

test('streamed input limits, UTF-8 validity and exact BOM bytes are enforced', async () => {
  const request = value => new Request(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: value });
  await assert.rejects(readJSONText(request('abc'), 2), error => error.status === 413);
  await assert.rejects(readJSONText(request(new Uint8Array([0xff]))), /UTF-8/);
  assert.equal(await readJSONText(request('\uFEFF[]')), '\uFEFF[]');
  await assert.rejects(readJSONText(new Request(origin, { method: 'POST', body: '[]' })), error => error.status === 415);
});

test('server GitHub requests identify the app and stop oversized response streams', async () => {
  let seenHeaders;
  const fetch = createServerGitHubFetch(async function (_url, options) {
    assert.equal(this, globalThis);
    seenHeaders = options.headers;
    return new Response(source);
  });
  const response = await fetch('https://api.github.com/repos/budhi-halim/seo-yuna/contents/data.json?ref=master',
    { headers: { Authorization: 'Bearer server-fixture' } });
  assert.equal(seenHeaders.get('User-Agent'), 'seo-yuna-owner');
  assert.equal(seenHeaders.get('Authorization'), 'Bearer server-fixture');
  assert.equal(await response.text(), source);
  const oversized = createServerGitHubFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close(); },
  })));
  const tooLarge = await oversized('https://api.github.com/repos/budhi-halim/seo-yuna/git/blobs');
  await assert.rejects(tooLarge.text(), /limit exceeded/);
});
