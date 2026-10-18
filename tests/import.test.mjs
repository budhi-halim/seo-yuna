import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  API_VERSION, REPOSITORY, MAX_CATALOG_BYTES, GitHubClient, GitHubApiError,
  gitBlobSha, sha256Hex, readDispatch, mergeRemoteCatalog, runValidation, runMerge,
} from '../tools/import-data.mjs';
import { MAX_IMPORT_BYTES, measureCatalogBytes } from '../assets/catalog.mjs';
import { buildSite } from '../tools/build-site.mjs';

const TOKEN = 'fixture-token-not-a-real-credential';
const BASE_ENV = {
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REF: 'refs/heads/master',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_ACTOR: 'budhi-halim',
  GITHUB_TOKEN: TOKEN,
};
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const item = (id = 'existing', prompt = 'Original prompt') => ({
  id, name: 'Theme ' + id, variations: [{ id: id + '-prompt', name: 'Prompt ' + id, prompt }],
});
const encode = (catalog) => Buffer.from(JSON.stringify(catalog, null, 2) + '\n');

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'seo-yuna-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fakeGitHub(initial, { incoming, conflicts = 0, onConflict, failStatus } = {}) {
  const snapshots = new Map();
  const blobs = new Map();
  const calls = [];
  let catalog = structuredClone(initial);
  let sequence = 0;
  let head;
  let putCount = 0;
  function save() {
    const bytes = encode(catalog);
    const blobSha = gitBlobSha(bytes);
    head = String(++sequence).padStart(40, '0');
    blobs.set(blobSha, bytes);
    snapshots.set(head, { bytes, blobSha, catalog: structuredClone(catalog) });
  }
  save();
  if (incoming) {
    const bytes = Buffer.from(JSON.stringify(incoming));
    blobs.set(gitBlobSha(bytes), bytes);
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  async function fetchImpl(url, options = {}) {
    calls.push({ url, ...options });
    assert.ok(url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(options.redirect, 'error');
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace('/repos/budhi-halim/seo-yuna', '');
    if (endpoint === '/git/ref/heads/master') return json({ object: { sha: head } });
    if (endpoint === '/contents/data.json' && options.method === 'GET') {
      const snapshot = snapshots.get(parsed.searchParams.get('ref'));
      assert.ok(snapshot, 'reads must be pinned to a specific commit');
      return json({ type: 'file', sha: snapshot.blobSha, size: snapshot.bytes.byteLength, encoding: 'none', content: '' });
    }
    if (endpoint.startsWith('/git/blobs/')) {
      assert.equal(options.headers.Accept, 'application/vnd.github.raw+json');
      const bytes = blobs.get(endpoint.slice('/git/blobs/'.length));
      return bytes ? new Response(bytes) : json({}, 404);
    }
    if (endpoint === '/contents/data.json' && options.method === 'PUT') {
      putCount += 1;
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['branch', 'content', 'message', 'sha']);
      assert.equal(body.branch, 'master');
      if (failStatus) return json({ message: '<script>do not log server content</script>' }, failStatus);
      if (putCount <= conflicts) {
        if (onConflict) catalog = onConflict(structuredClone(catalog), putCount);
        save();
        return json({}, 409);
      }
      assert.equal(body.sha, snapshots.get(head).blobSha, 'updates must use the current blob SHA');
      catalog = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
      save();
      return json({ commit: { sha: head }, content: { sha: snapshots.get(head).blobSha } });
    }
    return json({}, 404);
  }
  return {
    fetchImpl, calls,
    get catalog() { return catalog; },
    get putCount() { return putCount; },
    get head() { return head; },
    get bytes() { return snapshots.get(head).bytes; },
  };
}

async function workflowEnv(directory, incoming, overrides = {}) {
  const bytes = Buffer.from(JSON.stringify(incoming));
  const inputs = {
    payload_blob_sha: gitBlobSha(bytes),
    request_id: REQUEST_ID,
    sha256: sha256Hex(bytes),
  };
  const event = { repository: { full_name: REPOSITORY }, sender: { login: 'budhi-halim' }, inputs };
  const eventPath = path.join(directory, 'event');
  await writeFile(eventPath, JSON.stringify(event));
  return {
    ...BASE_ENV, RUNNER_TEMP: path.join(directory, 'runner-temp'),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: path.join(directory, 'outputs'),
    GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
    ...overrides,
  };
}

test('dispatch accepts only the new repository, owner and master branch', () => {
  assert.deepEqual(readDispatch({}, BASE_ENV), { mode: 'publish' });
  assert.deepEqual(readDispatch({}, { ...BASE_ENV, GITHUB_EVENT_NAME: 'push', GITHUB_ACTOR: 'collaborator' }), { mode: 'publish' });
  const cases = [
    [{}, { ...BASE_ENV, GITHUB_REPOSITORY: 'budhi-halim/sakura-yuki' }, 'wrong_repository'],
    [{ repository: { full_name: 'budhi-halim/sakura-yuki' } }, BASE_ENV, 'wrong_repository'],
    [{}, { ...BASE_ENV, GITHUB_REF: 'refs/heads/other' }, 'wrong_branch'],
    [{}, { ...BASE_ENV, GITHUB_REF: 'refs/heads/main' }, 'wrong_branch'],
    [{}, { ...BASE_ENV, GITHUB_ACTOR: 'someone-else' }, 'wrong_actor'],
    [{ sender: { login: 'someone-else' } }, BASE_ENV, 'wrong_actor'],
    [{}, { ...BASE_ENV, GITHUB_EVENT_NAME: 'pull_request' }, 'wrong_event'],
    [null, BASE_ENV, 'invalid_event'],
  ];
  for (const [event, env, code] of cases) {
    assert.throws(() => readDispatch(event, env), { code });
  }
});

test('dispatch requires all import identifiers together and rejects malformed inputs', () => {
  const inputs = { payload_blob_sha: 'a'.repeat(40), request_id: REQUEST_ID, sha256: 'b'.repeat(64) };
  assert.equal(readDispatch({ inputs }, BASE_ENV).mode, 'import');
  const invalid = [
    null, [], { payload_blob_sha: 'a'.repeat(40) }, { ...inputs, sha256: '' },
    { ...inputs, request_id: '../unsafe' }, { ...inputs, request_id: 'a'.repeat(101) },
    { ...inputs, sha256: null }, { ...inputs, hidden: 'extra' },
  ];
  for (const value of invalid) assert.throws(() => readDispatch({ inputs: value }, BASE_ENV), { code: 'invalid_inputs' });
});

test('publish-only validation never calls the network or needs a credential', async (t) => {
  const directory = await fixture(t);
  const eventPath = path.join(directory, 'event');
  await writeFile(eventPath, '{}');
  const result = await runValidation({
    env: { ...BASE_ENV, GITHUB_TOKEN: undefined, GITHUB_EVENT_PATH: eventPath },
    fetchImpl: () => { throw new Error('Network must not be called'); }, log: () => {},
  });
  assert.equal(result.mode, 'publish');
});

test('the authenticated client refuses every API path outside its exact catalog operations', async () => {
  let calls = 0;
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  for (const endpoint of ['/../../sakura-yuki/contents/data.json', '/contents/other.json', '/git/refs/heads/master', '/git/ref/heads/main', '//example.com']) {
    await assert.rejects(client.request(endpoint), { code: 'invalid_api_path' });
  }
  await assert.rejects(client.request('/contents/data.json', { method: 'DELETE' }), { code: 'invalid_api_path' });
  assert.equal(calls, 0);
});

test('validated import merges once and emits only counts in logs and summaries', async (t) => {
  const directory = await fixture(t);
  const malicious = '<script>alert(1)</script> $(touch injected) || exit 1';
  const incoming = [{ ...item('new', malicious), name: malicious }];
  const api = fakeGitHub([item()], { incoming });
  const env = await workflowEnv(directory, incoming);
  const logs = [];
  await runValidation({ env, fetchImpl: api.fetchImpl, log: (line) => logs.push(line) });
  const result = await runMerge({ env, directory, fetchImpl: api.fetchImpl, log: (line) => logs.push(line), sleep: async () => {} });
  assert.equal(result.addedThemes, 1);
  assert.equal(result.addedVariations, 1);
  assert.equal(api.putCount, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8')), [item(), ...incoming]);
  const summary = await readFile(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.ok(!summary.includes(malicious) && !summary.includes('<script>'));
  assert.ok(!logs.join('\n').includes(malicious) && !logs.join('\n').includes(TOKEN));
  const outputs = await readFile(env.GITHUB_OUTPUT, 'utf8');
  assert.match(outputs, /^commit_sha=[a-f0-9]{40}$/m);
  assert.match(outputs, /^added_themes=1$/m);
  assert.match(outputs, /^changed=true$/m);
});

test('checksum mismatch stops validation before any commit', async (t) => {
  const directory = await fixture(t);
  const incoming = [item('new')];
  const api = fakeGitHub([item()], { incoming });
  const env = await workflowEnv(directory, incoming);
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  event.inputs.sha256 = '0'.repeat(64);
  await writeFile(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  await assert.rejects(runValidation({ env, fetchImpl: api.fetchImpl, log: () => {} }), { code: 'checksum_mismatch' });
  assert.equal(api.putCount, 0);
});

test('invalid uploaded schema is rejected before the remote catalog is read', async (t) => {
  const directory = await fixture(t);
  const incoming = [{ ...item('new'), extra: true }];
  const api = fakeGitHub([item()], { incoming });
  const env = await workflowEnv(directory, incoming);
  await assert.rejects(runValidation({ env, fetchImpl: api.fetchImpl, log: () => {} }), { code: 'unknown_field' });
  assert.equal(api.calls.length, 1);
  assert.equal(api.putCount, 0);
});

test('validation cannot be redirected to the old repository', async (t) => {
  const directory = await fixture(t);
  const env = await workflowEnv(directory, [item('new')], { GITHUB_REPOSITORY: 'budhi-halim/sakura-yuki' });
  let calls = 0;
  await assert.rejects(runValidation({
    env, fetchImpl: async () => { calls += 1; throw new Error('Unexpected network'); }, log: () => {},
  }), { code: 'wrong_repository' });
  assert.equal(calls, 0);
});

test('optimistic retry re-reads and re-merges master without losing another update', async (t) => {
  const directory = await fixture(t);
  const api = fakeGitHub([item()], {
    conflicts: 1,
    onConflict: (current) => [...current, item('other-writer')],
  });
  const delays = [];
  const result = await mergeRemoteCatalog({
    incoming: [item('new')], client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {}, sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.equal(result.attempts, 2);
  assert.equal(api.putCount, 2);
  assert.equal(result.addedThemes, 1);
  assert.deepEqual(api.catalog.map((entry) => entry.id), ['existing', 'other-writer', 'new']);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8')), api.catalog);
  assert.deepEqual(delays, [1000]);
});

test('retry becomes an idempotent no-op when the competing writer already imported the batch', async (t) => {
  const directory = await fixture(t);
  const incoming = [item('new')];
  const api = fakeGitHub([item()], { conflicts: 1, onConflict: (current) => [...current, ...incoming] });
  const result = await mergeRemoteCatalog({
    incoming, client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {}, sleep: async () => {},
  });
  assert.equal(result.changed, false);
  assert.equal(result.duplicateVariations, 1);
  assert.equal(result.attempts, 2);
  assert.equal(api.putCount, 1);
});

test('repeated conflicts are bounded and do not replace the local file', async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'data.json'), 'local sentinel');
  const api = fakeGitHub([item()], { conflicts: 10 });
  await assert.rejects(mergeRemoteCatalog({
    incoming: [item('new')], client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {}, sleep: async () => {},
  }), { code: 'commit_conflict' });
  assert.equal(api.putCount, 4);
  assert.equal(await readFile(path.join(directory, 'data.json'), 'utf8'), 'local sentinel');
});

test('identical batch skips the commit and retains the remote file bytes', async (t) => {
  const directory = await fixture(t);
  const current = [item()];
  const api = fakeGitHub(current);
  const result = await mergeRemoteCatalog({
    incoming: current, client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {},
  });
  assert.equal(result.changed, false);
  assert.equal(result.duplicateVariations, 1);
  assert.equal(api.putCount, 0);
  assert.deepEqual(await readFile(path.join(directory, 'data.json')), api.bytes);
});

test('a late content conflict cannot commit the otherwise-valid part of a batch', async (t) => {
  const directory = await fixture(t);
  const api = fakeGitHub([item()]);
  await assert.rejects(mergeRemoteCatalog({
    incoming: [item('new'), item('existing', 'Attempted overwrite')],
    client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }), directory, log: () => {},
  }), { code: 'variation_conflict' });
  assert.equal(api.putCount, 0);
  assert.deepEqual(api.catalog, [item()]);
});

test('permission errors are not retried and do not log GitHub response contents', async (t) => {
  const directory = await fixture(t);
  const api = fakeGitHub([item()], { failStatus: 403 });
  await assert.rejects(mergeRemoteCatalog({
    incoming: [item('new')], client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {}, sleep: async () => {},
  }), (error) => error instanceof GitHubApiError && error.status === 403 && !error.message.includes('<script>'));
  assert.equal(api.putCount, 1);
});

test('download cap is enforced even when the response has no content-length header', async () => {
  const maximumBytes = 64;
  const bytes = Buffer.alloc(maximumBytes + 1, 32);
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => new Response(bytes) });
  await assert.rejects(client.blob(gitBlobSha(bytes), maximumBytes), { code: 'response_too_large' });
});

test('the 100 MB response header is checked before consuming the download stream', async () => {
  let cancelled = false;
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { 'content-length': String(MAX_IMPORT_BYTES + 1) } }) });
  await assert.rejects(client.blob('a'.repeat(40)), { code: 'response_too_large' });
  assert.equal(cancelled, true);
});

test('a corrupt blob response is rejected by its content-addressed SHA', async () => {
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => new Response('altered') });
  await assert.rejects(client.blob('a'.repeat(40)), { code: 'blob_integrity_error' });
});

test('a stored catalog above the former 16 MiB cap can be downloaded, extended and built', async (t) => {
  const directory = await fixture(t);
  const large = [{
    id: 'large-theme', name: 'Large theme',
    variations: Array.from({ length: 480 }, (_, index) => ({
      id: 'large-prompt-' + index, name: 'Large prompt ' + index, prompt: 'p'.repeat(37_000),
    })),
  }];
  assert.ok(measureCatalogBytes(large, { pretty: true }) > 16 * 1024 * 1024);
  assert.ok(measureCatalogBytes(large, { pretty: true }) < MAX_CATALOG_BYTES);
  const api = fakeGitHub(large);
  const result = await mergeRemoteCatalog({
    incoming: [item('new')], client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, log: () => {},
  });
  assert.equal(result.addedThemes, 1);
  assert.equal(api.catalog[0].variations.length, 480);
  assert.equal(api.putCount, 1);
  await mkdir(path.join(directory, 'assets'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Large catalog fixture</title>');
  await writeFile(path.join(directory, 'rulebook.txt'), 'Rules');
  const built = await buildSite({ directory, env: { BUILD_SHA: 'c'.repeat(40) }, log: () => {} });
  assert.equal(built.variations, 481);
  assert.deepEqual(await readFile(path.join(built.directory, 'data.json')), api.bytes);
});

test('a stored file above GitHub\'s 100 MB boundary is refused before its contents are downloaded', async () => {
  let calls = 0;
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1
      ? { object: { sha: 'a'.repeat(40) } }
      : { type: 'file', size: MAX_CATALOG_BYTES + 1, sha: 'b'.repeat(40) }));
  } });
  await assert.rejects(client.snapshot(), { code: 'catalog_too_large' });
  assert.equal(calls, 2);
});

test('pretty canonical expansion is checked before any local or remote modification', async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'data.json'), 'local sentinel');
  const current = [item()];
  const incoming = [item('new')];
  const finalCatalog = [...current, ...incoming];
  const maximumCatalogBytes = Buffer.byteLength(JSON.stringify(finalCatalog));
  assert.ok(measureCatalogBytes(current, { pretty: true }) < maximumCatalogBytes);
  assert.ok(measureCatalogBytes(finalCatalog, { pretty: true }) > maximumCatalogBytes);
  const api = fakeGitHub(current);
  await assert.rejects(mergeRemoteCatalog({
    incoming, client: new GitHubClient({ token: TOKEN, fetchImpl: api.fetchImpl }),
    directory, maximumCatalogBytes, log: () => {},
  }), { code: 'catalog_too_large' });
  assert.equal(api.putCount, 0);
  assert.equal(await readFile(path.join(directory, 'data.json'), 'utf8'), 'local sentinel');
});

test('the final update checks its byte size before allocating a Base64 body or calling GitHub', async () => {
  let calls = 0;
  const client = new GitHubClient({ token: TOKEN, fetchImpl: async () => { calls += 1; } });
  const bytes = { byteLength: MAX_CATALOG_BYTES + 1, toString() { throw new Error('Must not encode'); } };
  await assert.rejects(client.update(bytes, 'a'.repeat(40)), { code: 'catalog_too_large' });
  assert.equal(calls, 0);
});

test('site build publishes only its explicit public files and preserves catalog bytes', async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'assets', 'nested'), { recursive: true });
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Fixture</title>');
  const bytes = encode([item()]);
  await writeFile(path.join(directory, 'data.json'), bytes);
  await writeFile(path.join(directory, 'rulebook.txt'), 'Original rules.\n');
  await writeFile(path.join(directory, 'assets', 'app.mjs'), 'export const fixture = true;');
  await writeFile(path.join(directory, 'assets', 'nested', 'icon.svg'), '<svg/>');
  await writeFile(path.join(directory, 'prompt.txt'), 'Not a public artifact.');
  await writeFile(path.join(directory, 'README.md'), 'Not a public artifact.');
  const result = await buildSite({ directory, env: { BUILD_SHA: 'c'.repeat(40) }, log: () => {} });
  assert.deepEqual((await readdir(result.directory)).sort(), ['assets', 'data.json', 'index.html', 'rulebook.txt', 'version.txt']);
  assert.deepEqual(await readFile(path.join(result.directory, 'data.json')), bytes);
  assert.equal(await readFile(path.join(result.directory, 'version.txt'), 'utf8'), 'c'.repeat(40) + '\n');
  assert.equal(result.variations, 1);
  assert.ok(result.files.includes(path.join('assets', 'nested', 'icon.svg')));
});

test('site build rejects symbolic links before replacing the existing build', async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(directory, '_site'));
  await writeFile(path.join(directory, '_site', 'sentinel'), 'keep');
  await writeFile(path.join(directory, 'index.html'), '<!doctype html>');
  await writeFile(path.join(directory, 'data.json'), encode([item()]));
  await writeFile(path.join(directory, 'rulebook.txt'), 'Rules');
  await symlink(path.join(directory, 'rulebook.txt'), path.join(directory, 'assets', 'external'));
  await assert.rejects(buildSite({ directory, env: { BUILD_SHA: 'c'.repeat(40) }, log: () => {} }), /Symbolic links/);
  assert.equal(await readFile(path.join(directory, '_site', 'sentinel'), 'utf8'), 'keep');
});

test('site build refuses a file over the shared provider limit before reading it or replacing the build', async (t) => {
  const directory = await fixture(t);
  await mkdir(path.join(directory, '_site'));
  await writeFile(path.join(directory, '_site', 'sentinel'), 'keep');
  await writeFile(path.join(directory, 'index.html'), '<!doctype html>');
  await writeFile(path.join(directory, 'rulebook.txt'), 'Rules');
  await writeFile(path.join(directory, 'data.json'), '[]');
  await truncate(path.join(directory, 'data.json'), MAX_CATALOG_BYTES + 1);
  await assert.rejects(buildSite({ directory, env: { BUILD_SHA: 'c'.repeat(40) }, log: () => {} }), /100 MB/);
  assert.equal(await readFile(path.join(directory, '_site', 'sentinel'), 'utf8'), 'keep');
});
