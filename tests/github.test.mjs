import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubError, API_VERSION, describeRun, runUrl } from '../assets/github.mjs';

const receipt = { blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), requestId: 'batch-123' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('native browser fetch retains its global receiver for anonymous GitHub status requests', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async function (url, init) {
    assert.equal(this, globalThis, 'Window.fetch must not receive a GitHubClient instance');
    request = { url, init };
    return json({ id: 9 });
  });
  const client = new GitHubClient();
  assert.equal((await client.readRun(9)).id, 9);
  assert.equal(request.url, 'https://api.github.com/repos/budhi-halim/seo-yuna/actions/runs/9');
  assert.equal(request.init.headers.Authorization, undefined);
});

test('staging and dispatch stay in seo-yuna; only the blob reference enters workflow inputs', async () => {
  const calls = [];
  const client = new GitHubClient('test-token', async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/git/blobs') ? json({ sha: receipt.blobSha }, 201) : json({ workflow_run_id: 123 });
  });
  assert.equal(await client.stageBlob('[{"name":"literal <script>"}]'), receipt.blobSha);
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: 123 });
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
    assert.equal(call.init.headers.Authorization, 'Bearer test-token');
    assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(call.init.redirect, 'error');
    assert.ok(!call.url.includes('test-token'));
  }
  assert.deepEqual(JSON.parse(calls[1].init.body), { ref: 'master', inputs: {
    payload_blob_sha: receipt.blobSha, request_id: 'batch-123', sha256: receipt.digest,
  } });
  assert.ok(!calls[1].init.body.includes('literal'));
  assert.deepEqual(Object.keys(client), []);
});

test('an accepted dispatch without a readable run body remains accepted for recovery', async () => {
  const client = new GitHubClient('test', async () => new Response(null, { status: 204 }));
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: null });
});

test('connection loss is ambiguous and dispatch is never automatically repeated', async () => {
  let calls = 0;
  const client = new GitHubClient('secret', async () => { calls += 1; throw new Error('secret in upstream error'); });
  await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError && error.uncertain && !error.message.includes('secret'));
  assert.equal(calls, 1);
});

test('a definite API rejection is distinct from an unknown outcome; upstream bodies are not exposed', async () => {
  const client = new GitHubClient('test', async () => json({ message: 'untrusted credentials' }, 403));
  await assert.rejects(client.dispatch(receipt), error => error.status === 403 && !error.uncertain && !error.message.includes('untrusted'));
});

test('disconnect removes the credential from subsequent public status requests', async () => {
  let headers;
  const client = new GitHubClient('test', async (_, init) => { headers = init.headers; return json({ id: 1 }); });
  client.disconnect();
  assert.equal(client.connected, false);
  await client.readRun(1);
  assert.equal(headers.Authorization, undefined);
  await assert.rejects(client.stageBlob('[]'), /Connect to GitHub/);
});

test('a different GitHub account cannot connect owner access even with a token', async () => {
  const client = new GitHubClient('another-account-token', async url => {
    if (url.endsWith('/user')) return json({ login: 'visitor' });
    if (url.endsWith('/studio.yml')) return json({ state: 'active' });
    return json({ full_name: 'budhi-halim/seo-yuna', default_branch: 'master', permissions: { push: false } });
  });
  await assert.rejects(client.verifyConnection(), /budhi-halim account/);
});

test('reconciliation matches the exact persisted request ID, not the newest unrelated run', async () => {
  const client = new GitHubClient('', async () => json({ workflow_runs: [
    { id: 2, display_title: 'Import unrelated' }, { id: 1, display_title: 'Import batch-123' },
  ] }));
  assert.equal((await client.findRun('batch-123', '2026-10-18T00:00:00Z')).id, 1);
  assert.equal(await client.findRun('missing', '2026-10-18T00:00:00Z'), null);
});

test('invalid receipt or run identifiers cannot affect request destinations', async () => {
  const client = new GitHubClient('test', async () => { assert.fail('must not fetch'); });
  await assert.rejects(client.dispatch({ ...receipt, requestId: '../sakura-yuki' }), /incomplete/);
  assert.throws(() => client.readRun('../sakura-yuki'), /Invalid/);
  assert.equal(runUrl('javascript:alert(1)'), 'https://github.com/budhi-halim/seo-yuna/actions/workflows/studio.yml');
});

test('status distinguishes a failed publication after a successful merge', () => {
  const jobs = [{ steps: [{ name: 'Merge into data.json', conclusion: 'success' }, { name: 'Publish website', conclusion: 'failure' }] }];
  const saved = describeRun({ status: 'completed', conclusion: 'failure' }, jobs);
  assert.equal(saved.state, 'saved');
  assert.equal(saved.safe, true);
  assert.equal(saved.terminal, true);
  assert.equal(describeRun({ status: 'queued' }).state, 'queued');
  assert.equal(describeRun({ status: 'in_progress' }).state, 'running');
  assert.equal(describeRun({ status: 'completed', conclusion: 'success' }).state, 'published');
  assert.equal(describeRun({ status: 'completed', conclusion: 'cancelled' }).state, 'failed');
});
