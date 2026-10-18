import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, API_VERSION, OWNER, OWNER_ID, REPOSITORY_ID, WORKFLOW_PATH,
  isFineGrainedToken, describeRun, runUrl } from '../assets/github.mjs';

const token = `github_pat_${'A'.repeat(80)}`;
const receipt = { blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), requestId: 'batch-123' };
const user = { id: OWNER_ID, login: OWNER };
const repository = { id: REPOSITORY_ID, full_name: 'budhi-halim/seo-yuna', owner: user,
  default_branch: 'master', permissions: { push: true } };
const workflow = { id: 17, path: WORKFLOW_PATH, state: 'active' };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', ...headers } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(handler = () => undefined, options = {}) {
  const calls = [];
  const fetchImpl = async function (url, init) {
    assert.equal(this, globalThis, 'native fetch must retain the global receiver');
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com');
    assert.ok(target.pathname === '/user' || target.pathname === '/repos/budhi-halim/seo-yuna' || target.pathname.startsWith('/repos/budhi-halim/seo-yuna/'));
    calls.push({ url, init });
    const override = await handler(url, init);
    if (override !== undefined) return override;
    if (target.pathname === '/user') return json(user);
    if (target.pathname === '/repos/budhi-halim/seo-yuna') return json(repository);
    if (target.pathname.endsWith('/actions/workflows/studio.yml')) return json(workflow);
    if (target.pathname.endsWith('/git/blobs')) return json({ sha: receipt.blobSha }, 201);
    if (target.pathname.endsWith('/dispatches')) return json({ workflow_run_id: 123 });
    if (target.pathname.endsWith('/contents/data.json')) return new Response('[]');
    if (target.pathname.endsWith('/jobs')) return json({ jobs: [] });
    if (target.pathname.endsWith('/runs')) return json({ workflow_runs: [] });
    const id = Number(target.pathname.split('/').at(-1));
    return json({ id, path: WORKFLOW_PATH, head_branch: 'master' });
  };
  return { client: new GitHubClient(token, fetchImpl, options), calls, fetchImpl };
}
async function connected(handler, options) {
  const result = fixture(handler, options);
  await result.client.verifyConnection();
  result.calls.length = 0;
  return result;
}

test('only fine-grained token syntax is accepted, without trimming or secret reflection', () => {
  assert.equal(isFineGrainedToken(token), true);
  for (const bad of [null, false, {}, 'github_pat_', 'ghp_broad', 'gho_oauth', 'github_pat_a\n', 'github_pat_a\r',
    'github_pat_a b', 'github_pat_a-b', 'github_pat_é', ` ${token}`, `${token} `, `github_pat_${'a'.repeat(502)}`]) {
    assert.equal(isFineGrainedToken(bad), false);
    assert.throws(() => new GitHubClient(bad, async () => assert.fail('no fetch')), error => error instanceof GitHubError &&
      error.status === 422 && !error.uncertain && !error.message.includes('ghp_broad'));
  }
});

test('anonymous native fetch is receiver-safe and omits browser credentials', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async function (url, init) {
    assert.equal(this, globalThis);
    request = { url, init };
    return json({ id: 9 });
  });
  const client = new GitHubClient();
  assert.equal((await client.readRun(9)).id, 9);
  assert.equal(request.url, 'https://api.github.com/repos/budhi-halim/seo-yuna/actions/runs/9');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(request.init.headers['X-GitHub-Api-Version'], API_VERSION);
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'manual');
});

test('holding a token is insufficient to write before verified owner connection', async () => {
  const { client, calls } = fixture();
  assert.equal(client.connected, false);
  await assert.rejects(client.stageBlob('[]'), error => error.status === 401 && !error.uncertain);
  await assert.rejects(client.dispatch(receipt), error => error.status === 401 && !error.uncertain);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.verifyConnection(), { login: OWNER });
  assert.equal(client.connected, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.github.com/user');
  assert.deepEqual(Object.keys(client), []);
  assert.equal(JSON.stringify(client), '{}');
  assert.throws(() => { client.connected = true; }, TypeError);
});

for (const [name, value] of [['null', null], ['array', []], ['missing fields', {}], ['ID string', { ...user, id: String(OWNER_ID) }],
  ['wrong numeric ID with correct name', { ...user, id: OWNER_ID + 1 }], ['wrong login with correct ID', { ...user, login: 'visitor' }]]) {
  test(`owner verification rejects ${name} before repository access`, async () => {
    const { client, calls } = fixture(url => url.endsWith('/user') ? json(value) : undefined);
    await assert.rejects(client.verifyConnection(), /budhi-halim account/);
    assert.equal(client.connected, false);
    assert.equal(calls.length, 1);
    await assert.rejects(client.dispatch(receipt), /local login/);
  });
}

for (const [name, value] of [['null', null], ['wrong ID', { ...repository, id: REPOSITORY_ID + 1 }],
  ['string ID', { ...repository, id: String(REPOSITORY_ID) }], ['wrong owner ID', { ...repository, owner: { ...user, id: OWNER_ID + 1 } }],
  ['wrong owner name', { ...repository, owner: { ...user, login: 'visitor' } }], ['wrong full name', { ...repository, full_name: 'budhi-halim/sakura-yuki' }],
  ['wrong branch', { ...repository, default_branch: 'main' }], ['missing permissions', { ...repository, permissions: undefined }],
  ['missing push permission', { ...repository, permissions: {} }], ['false push permission', { ...repository, permissions: { push: false } }],
  ['nonboolean push permission', { ...repository, permissions: { push: 'true' } }]]) {
  test(`repository verification fails closed for ${name}`, async () => {
    const { client } = fixture(url => url === 'https://api.github.com/repos/budhi-halim/seo-yuna' ? json(value) : undefined);
    await assert.rejects(client.verifyConnection(), error => error instanceof GitHubError && error.status === 403);
    assert.equal(client.connected, false);
  });
}

for (const [name, value] of [['null', null], ['missing ID', { path: WORKFLOW_PATH, state: 'active' }],
  ['wrong path', { ...workflow, path: '.github/workflows/other.yml' }], ['missing path', { ...workflow, path: undefined }],
  ['disabled workflow', { ...workflow, state: 'disabled_manually' }]]) {
  test(`workflow verification rejects ${name}`, async () => {
    const { client } = fixture(url => url.endsWith('/actions/workflows/studio.yml') ? json(value) : undefined);
    await assert.rejects(client.verifyConnection(), error => error instanceof GitHubError && error.status === 403);
    assert.equal(client.connected, false);
  });
}

test('reported classic OAuth scopes are refused and endpoint permission headers are not mistaken for token grants', async () => {
  const broad = fixture(url => url.endsWith('/user') ? json(user, 200, { 'X-OAuth-Scopes': 'repo, workflow' }) : undefined);
  await assert.rejects(broad.client.verifyConnection(), /fine-grained token limited to seo-yuna/);
  assert.equal(broad.client.connected, false);
  for (const headers of [{}, { 'X-OAuth-Scopes': '' }, { 'X-Accepted-GitHub-Permissions': 'contents=read' }]) {
    const { client } = fixture(url => url.endsWith('/user') ? json(user, 200, headers) : undefined);
    assert.deepEqual(await client.verifyConnection(), { login: OWNER });
  }
});

test('staging and dispatch use fixed GitHub routes and only blob references enter workflow inputs', async () => {
  const { client, calls } = await connected(url => url.endsWith('/dispatches') ? json({ workflow_run_id: 123,
    html_url: 'https://evil.example/', token, login: 'malicious' }) : undefined);
  const source = '[{"name":"literal <script> and $()"}]';
  assert.equal(await client.stageBlob(source), receipt.blobSha);
  assert.deepEqual(await client.dispatch({ ...receipt, token: 'must be discarded' }), { accepted: true, runId: 123 });
  for (const { url, init } of calls) {
    assert.ok(url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.equal(init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.cache, 'no-store');
    assert.equal(url.includes(token), false);
    assert.equal(init.body.includes(token), false);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: source, encoding: 'utf-8' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: 'master', inputs: {
    payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest,
  } });
});

test('HTTP acceptance survives absent, malformed, or unusable run details', async () => {
  const responses = [() => new Response(null, { status: 204 }), () => new Response('bad upstream body'),
    () => json(null), () => json([]), () => json({ workflow_run_id: true }), () => json({ workflow_run_id: '1e3' }),
    () => json({ workflow_run_id: '9\n' }), () => json({ workflow_run_id: 0 }), () => json({ workflow_run_id: Number.MAX_SAFE_INTEGER + 1 })];
  for (const response of responses) {
    const { client } = await connected(url => url.endsWith('/dispatches') ? response() : undefined);
    assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: null });
  }
  const { client } = await connected(url => url.endsWith('/dispatches') ? json({ workflow_run_id: '123' }) : undefined);
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: 123 });
});

test('known HTTP acceptance survives a stalled response-body timeout', async () => {
  const { client, calls } = await connected(url => url.endsWith('/dispatches') ?
    new Response(new ReadableStream({ start() {} }), { status: 200 }) : undefined, { timeoutMs: 25 });
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: null });
  assert.equal(calls.length, 1);
});

test('known HTTP acceptance survives disconnect while its optional body is being read', async () => {
  const reading = deferred();
  const { client } = await connected(url => url.endsWith('/dispatches') ? new Response(new ReadableStream({
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 }), { status: 200 }) : undefined);
  const dispatch = client.dispatch(receipt);
  await reading.promise;
  client.disconnect();
  assert.deepEqual(await dispatch, { accepted: true, runId: null });
  assert.equal(client.connected, false);
});

for (const status of [301, 302, 303, 304, 307, 308]) {
  test(`redirect ${status} is not followed and never treated as acceptance`, async () => {
    const { client, calls } = await connected(url => url.endsWith('/dispatches') ?
      new Response(null, { status, headers: { Location: `https://evil.example/?token=${token}` } }) : undefined);
    await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError && error.uncertain &&
      /redirect/.test(error.message) && !error.message.includes(token) && !error.message.includes('evil.example'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
  });
}

test('opaque redirects and response adapters pointing elsewhere are rejected', async () => {
  for (const properties of [{ type: 'opaqueredirect', status: 0 }, { redirected: true },
    { url: 'https://api.github.com/repos/budhi-halim/sakura-yuki' }, { url: 'https://api.github.com.evil.example/user' }]) {
    const response = json(user);
    for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
    const { client, calls } = fixture(url => url.endsWith('/user') ? response : undefined);
    await assert.rejects(client.verifyConnection(), /redirect/);
    assert.equal(client.connected, false);
    assert.equal(calls.length, 1);
  }
});

test('dispatch transport failures are uncertain, redacted, and never automatically retried', async () => {
  for (const upstream of [new Error(`credential ${token}`), new GitHubError(`credential ${token}`)]) {
    const { client, calls } = await connected(url => { if (url.endsWith('/dispatches')) throw upstream; });
    await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError && error.uncertain &&
      !error.message.includes(token) && error.cause === undefined);
    assert.equal(calls.length, 1);
  }
});

test('HTTP rejections are sanitized and distinguish definite failure from uncertain acceptance', async () => {
  for (const status of [401, 403, 404, 409, 422, 429, 500, 502, 503]) {
    const { client, calls } = await connected(url => url.endsWith('/dispatches') ? json({ message: token }, status) : undefined);
    await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError && error.status === status &&
      error.uncertain === (status >= 500) && !error.message.includes(token));
    assert.equal(calls.length, 1);
    if ([401, 403].includes(status)) assert.equal(client.connected, false);
  }
});

test('a GitHub rate limit does not discard a valid local connection', async () => {
  for (const headers of [{ 'X-RateLimit-Remaining': '0' }, { 'X-RateLimit-Remaining': '4999', 'Retry-After': '60' }]) {
    const { client } = await connected(url => url.endsWith('/dispatches') ? json({ message: token }, 403, headers) : undefined);
    await assert.rejects(client.dispatch(receipt), error => error.status === 403 && !error.uncertain && /limiting/.test(error.message) &&
      error.retryAfterSeconds === (headers['Retry-After'] ? 60 : null));
    assert.equal(client.connected, true);
  }
});

test('timeout and disconnect cancel requests even when a fetch adapter ignores AbortSignal', async () => {
  const timeout = fixture(url => url.endsWith('/user') ? new Promise(() => {}) : undefined, { timeoutMs: 20 });
  await assert.rejects(timeout.client.verifyConnection(), error => !error.uncertain && /timed out/.test(error.message));
  assert.equal(timeout.client.connected, false);
  const waiting = deferred();
  const { client, calls } = fixture(url => url.endsWith('/user') ? waiting.promise : undefined);
  const verify = client.verifyConnection();
  client.disconnect();
  await assert.rejects(verify, error => error instanceof GitHubError && !error.uncertain);
  waiting.resolve(json(user));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.connected, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.signal.aborted, true);
});

test('disconnect clears the token from all later public reads', async () => {
  const { client, calls } = await connected();
  client.disconnect();
  assert.equal(await client.readCanonical(), '[]');
  await client.readRun(1); await client.readJobs(1); await client.findRun(receipt.requestId, '2026-10-18T00:00:00Z');
  for (const { init } of calls) assert.equal(init.headers.Authorization, undefined);
  await assert.rejects(client.stageBlob('[]'), /local login/);
});

test('malformed GitHub responses fail closed without exposing their content', async () => {
  for (const value of [null, [], {}, { jobs: null }, { jobs: [null] }, { jobs: [{ run_id: 10 }] }, { jobs: [{ steps: {} }] }]) {
    const { client } = fixture(url => url.includes('/jobs?') ? json(value) : undefined);
    await assert.rejects(client.readJobs(9), /could not be verified/);
  }
  for (const value of [null, [], {}, { id: 10 }, { id: 9, path: '.github/workflows/other.yml' },
    { id: 9, repository: { id: 1, full_name: 'budhi-halim/seo-yuna' } }]) {
    const { client } = fixture(url => url.endsWith('/runs/9') ? json(value) : undefined);
    await assert.rejects(client.readRun(9), /could not be verified/);
  }
  const { client } = fixture(url => url.endsWith('/user') ? new Response(`not json ${token}`) : undefined);
  await assert.rejects(client.verifyConnection(), error => !error.message.includes(token));
});

test('reconciliation matches exact request and owner and paginates without automatic dispatch', async () => {
  const { client, calls } = fixture(url => {
    if (!url.includes('/studio.yml/runs?')) return undefined;
    const page = new URL(url).searchParams.get('page');
    return page === '1' ? json({ workflow_runs: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, display_title: 'Import unrelated' })) }) :
      json({ workflow_runs: [{ id: 200, display_title: `Import ${receipt.requestId}`, actor: { id: 2, login: OWNER } },
        { id: 201, display_title: `Import ${receipt.requestId}`, actor: user, path: WORKFLOW_PATH, head_branch: 'master' }] });
  });
  assert.equal((await client.findRun(receipt.requestId, '2026-10-18T00:00:00Z')).id, 201);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).searchParams.get('created'), '>=2026-10-17T23:55:00.000Z');
  assert.equal(calls.every(call => call.init.method === 'GET'), true);
});

test('malformed run lists are rejected rather than silently treating a submission as missing', async () => {
  for (const value of [null, {}, { workflow_runs: null }, { workflow_runs: 'bad' }, { workflow_runs: [null] }]) {
    const { client } = fixture(url => url.includes('/studio.yml/runs?') ? json(value) : undefined);
    await assert.rejects(client.findRun(receipt.requestId, '2026-10-18T00:00:00Z'), /could not be verified/);
  }
});

test('untrusted identifiers and invalid uploads cause no network call', async () => {
  const { client, calls } = await connected();
  for (const id of [null, true, {}, 0, -1, '01', '9\n', '../sakura-yuki', 'https://evil.example/1', '1e3', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.readRun(id), /Invalid/);
    await assert.rejects(client.readJobs(id), /Invalid/);
    assert.equal(runUrl(id), 'https://github.com/budhi-halim/seo-yuna/actions/workflows/studio.yml');
  }
  for (const bad of [null, {}, { ...receipt, blobSha: `${'a'.repeat(39)}\n` }, { ...receipt, digest: 'b'.repeat(63) },
    { ...receipt, requestId: '../sakura-yuki' }, { ...receipt, requestId: 'batch-123\n' }]) await assert.rejects(client.dispatch(bad), /incomplete/);
  await assert.rejects(client.findRun('x&leak=1', '2026-10-18T00:00:00Z'), /Invalid/);
  await assert.rejects(client.findRun(receipt.requestId, 'not a date'), /Invalid/);
  await assert.rejects(client.findRun(receipt.requestId, '2026-10-18T00:00:00Z\n'), /Invalid/);
  await assert.rejects(client.stageBlob(''), /JSON text/);
  await assert.rejects(client.stageBlob('あ'.repeat(2 * 1024 * 1024)), /5 MiB/);
  assert.equal(calls.length, 0);
});

test('canonical catalog reads enforce the 16 MiB worker/build limit', async () => {
  for (const response of [() => new Response('[]', { headers: { 'Content-Length': String(16 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(16 * 1024 * 1024 + 1))]) {
    const { client } = fixture(url => url.includes('/contents/data.json?') ? response() : undefined);
    await assert.rejects(client.readCanonical(), error => error.status === 413 && !error.uncertain);
  }
});

test('status distinguishes a failed publication after a successful merge', () => {
  const jobs = [{ steps: [{ name: 'Merge into data.json', conclusion: 'success' }, { name: 'Publish website', conclusion: 'failure' }] }];
  const saved = describeRun({ status: 'completed', conclusion: 'failure' }, jobs);
  assert.equal(saved.state, 'saved'); assert.equal(saved.safe, true); assert.equal(saved.terminal, true);
  assert.equal(describeRun({ status: 'queued' }).state, 'queued');
  assert.equal(describeRun({ status: 'in_progress' }).state, 'running');
  assert.equal(describeRun({ status: 'completed', conclusion: 'success' }).state, 'published');
  assert.equal(describeRun({ status: 'completed', conclusion: 'cancelled' }).state, 'failed');
});
