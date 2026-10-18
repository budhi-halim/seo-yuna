import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPrivateKey, verify, webcrypto } from 'node:crypto';
import { AppGitHubClient, GitHubError, OWNER, OWNER_ID, REPOSITORY, REPOSITORY_ID,
  BRANCH, WORKFLOW, API_VERSION } from '../owner/github-app.mjs';

const clock = Date.parse('2026-10-18T12:00:00Z');
const appId = 123456;
const installationId = 987654;
const slug = 'seo-yuna-owner-test';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const pkcs8 = createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'pem' });
const config = { appId, installationId, slug, privateKey };
const receipt = { blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), requestId: 'owner-batch-123' };
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

function fixture({ clientConfig = config, target = installation, list = [installation],
  tokenChanges = {}, now = () => clock, repoResponse, cryptoImpl = webcrypto, timeoutMs,
  intercept } = {}) {
  const calls = [];
  let minted = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const handled = intercept && await intercept(url, init);
    if (handled !== undefined) return handled;
    if (url.endsWith('/installation')) return json(copy(target));
    if (url.includes('/app/installations?')) return json(copy(list));
    if (url.endsWith('/access_tokens')) {
      minted += 1;
      return json({ token: `ghs_${appId}_eyJhbGciOiJIUzI1NiJ9.test-signature-${minted}`,
        expires_at: new Date(now() + 3600000).toISOString(),
        permissions: { contents: 'write', actions: 'write', metadata: 'read' },
        repository_selection: 'selected', repositories: [copy(repository)],
        ...copy(tokenChanges),
      }, 201);
    }
    if (repoResponse) return repoResponse(url, init);
    if (url.includes('/contents/data.json?')) return new Response('[{"preserved":"original"}]');
    if (url.endsWith('/git/blobs')) return json({ sha: receipt.blobSha }, 201);
    if (url.endsWith('/dispatches')) return json({ workflow_run_id: 456 });
    if (url.includes('/jobs?')) return json({ jobs: [{ id: 777, steps: [] }] });
    if (url.includes('/actions/runs/')) return json({ id: 456, status: 'queued' });
    throw new Error('Unexpected test route');
  };
  const client = new AppGitHubClient(clientConfig, { fetchImpl, cryptoImpl, now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return { client, calls, minted: () => minted };
}

test('PKCS1 and PKCS8 keys produce verifiable RS256 JWTs with bounded lifetime', async t => {
  for (const pem of [privateKey, pkcs8]) {
    await t.test(pem.includes('RSA PRIVATE') ? 'GitHub PKCS1 PEM' : 'PKCS8 PEM', async () => {
      let imported;
      const cryptoImpl = { subtle: {
        importKey: async (...args) => {
          imported = await webcrypto.subtle.importKey(...args);
          return imported;
        },
        sign: (...args) => webcrypto.subtle.sign(...args),
      } };
      const { client, calls } = fixture({ clientConfig: { ...config, privateKey: pem }, cryptoImpl });
      const metadata = await client.verifyInstallation();
      assert.equal(imported.extractable, false);
      assert.deepEqual(imported.usages, ['sign']);
      const token = calls[0].init.headers.Authorization.slice('Bearer '.length);
      const [header, claims, signature] = token.split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
      const payload = JSON.parse(Buffer.from(claims, 'base64url'));
      assert.equal(payload.iss, String(appId));
      assert.equal(payload.iat, clock / 1000 - 60);
      assert.ok(payload.exp > clock / 1000 && payload.exp <= clock / 1000 + 600);
      assert.ok(payload.exp - payload.iat <= 600);
      assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey,
        Buffer.from(signature, 'base64url')));
      assert.deepEqual(metadata, { appId, installationId, slug, ownerId: OWNER_ID, owner: OWNER,
        repositoryId: REPOSITORY_ID, repository: REPOSITORY });
      assert.deepEqual(Object.keys(client), []);
      assert.equal(JSON.stringify(client), '{}');
      assert.ok(!JSON.stringify(metadata).includes('PRIVATE KEY'));
      assert.ok(!JSON.stringify(metadata).includes('ghs_'));
    });
  }
});

test('installation verification discovers only the fixed owner and repository installation', async () => {
  const { client, calls } = fixture({ clientConfig: { appId, privateKey } });
  assert.equal((await client.verifyInstallation()).installationId, installationId);
  assert.ok(calls.some(call => call.url === `https://api.github.com/repos/${REPOSITORY}/installation`));
  assert.ok(calls.some(call => call.url === 'https://api.github.com/app/installations?per_page=100&page=1'));
});

test('wrong owners, app IDs, installation IDs, and permissions are rejected before token creation', async t => {
  const cases = [
    ['owner ID', { ...copy(installation), account: { id: 2, login: OWNER } }],
    ['owner name', { ...copy(installation), account: { id: OWNER_ID, login: 'somebody-else' } }],
    ['app ID', { ...copy(installation), app_id: appId + 1 }],
    ['installation ID', { ...copy(installation), id: installationId + 1 }],
    ['app slug', { ...copy(installation), app_slug: 'another-app' }],
    ['target owner', { ...copy(installation), target_id: 42 }],
    ['target type', { ...copy(installation), target_type: 'Organization' }],
    ['suspension', { ...copy(installation), suspended_at: '2026-10-18T00:00:00Z' }],
    ['missing Actions permission', { ...copy(installation), permissions: { contents: 'write' } }],
  ];
  for (const [name, target] of cases) await t.test(name, async () => {
    const { client, calls } = fixture({ target });
    await assert.rejects(client.verifyInstallation(), error => error instanceof GitHubError &&
      error.status === 403 && !error.uncertain);
    assert.ok(calls.every(call => call.init.method === 'GET'));
  });
});

test('the fixed repository installation must also occur in the app installation list', async () => {
  const { client, calls } = fixture({ list: [{ ...copy(installation), id: installationId + 1 }] });
  await assert.rejects(client.verifyInstallation(), /not found/);
  assert.ok(calls.every(call => call.init.method === 'GET'));
});

test('repository-scoped token requests cannot include sakura-yuki or broader permissions', async () => {
  const { client, calls } = fixture();
  await client.verifyInstallation();
  const mint = calls.find(call => call.url.endsWith('/access_tokens'));
  assert.equal(mint.url, `https://api.github.com/app/installations/${installationId}/access_tokens`);
  assert.deepEqual(JSON.parse(mint.init.body), { repository_ids: [REPOSITORY_ID],
    permissions: { contents: 'write', actions: 'write' } });
  assert.ok(!JSON.stringify(calls).includes('sakura-yuki'));
});

test('returned token repository identity, exact permissions, and expiration are enforced', async t => {
  const cases = [
    ['wrong repository ID', { repositories: [{ ...copy(repository), id: 99 }] }],
    ['old repository name', { repositories: [{ ...copy(repository), full_name: `${OWNER}/sakura-yuki` }] }],
    ['wrong repository owner', { repositories: [{ ...copy(repository), owner: { id: 3, login: OWNER } }] }],
    ['extra repository', { repositories: [copy(repository), { id: 2 }] }],
    ['missing repository list', { repositories: undefined }],
    ['broad repository selection', { repository_selection: 'all' }],
    ['wrong default branch', { repositories: [{ ...copy(repository), default_branch: 'main' }] }],
    ['extra permission', { permissions: { contents: 'write', actions: 'write', administration: 'write' } }],
    ['insufficient permission', { permissions: { contents: 'read', actions: 'write' } }],
    ['expired token', { expires_at: new Date(clock - 1000).toISOString() }],
    ['imminent expiration', { expires_at: new Date(clock + 1000).toISOString() }],
    ['unbounded expiration', { expires_at: new Date(clock + 7200000).toISOString() }],
    ['invalid expiration', { expires_at: 'forever' }],
    ['header injection', { token: 'token\r\nX-Injected: wrong' }],
  ];
  for (const [name, tokenChanges] of cases) await t.test(name, async () => {
    const { client, calls } = fixture({ tokenChanges });
    await assert.rejects(client.stageBlob('[]'), error => error instanceof GitHubError && !error.uncertain);
    assert.ok(!calls.some(call => call.url.endsWith('/git/blobs')));
  });
});

test('simultaneous operations share one verified session, refreshing before token expiration', async () => {
  let instant = clock;
  const { client, calls, minted } = fixture({ now: () => instant });
  const [canonical, run, jobs] = await Promise.all([client.readCanonical(), client.readRun(456), client.readJobs(456)]);
  assert.equal(canonical, '[{"preserved":"original"}]');
  assert.equal(run.id, 456);
  assert.equal(jobs.jobs[0].id, 777);
  assert.equal(minted(), 1);
  instant += 58 * 60000 + 1000;
  await Promise.all([client.readCanonical(), client.readRun(456)]);
  assert.equal(minted(), 2);
  const jwtCalls = calls.filter(call => call.url.endsWith('/installation'));
  const claims = jwtCalls.map(call => JSON.parse(Buffer.from(
    call.init.headers.Authorization.split('.')[1], 'base64url')));
  assert.ok(claims[1].iat > claims[0].iat);
  const repositoryCalls = calls.filter(call => call.url.includes('/contents/'));
  assert.notEqual(repositoryCalls[0].init.headers.Authorization, repositoryCalls[1].init.headers.Authorization);
});

test('staging and dispatch preserve their browser contracts and fixed destinations', async () => {
  const { client, calls } = fixture();
  assert.equal(await client.stageBlob('[{"name":"literal <script>"}]'), receipt.blobSha);
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: 456 });
  const blob = calls.find(call => call.url.endsWith('/git/blobs'));
  assert.deepEqual(JSON.parse(blob.init.body), { content: '[{"name":"literal <script>"}]', encoding: 'utf-8' });
  const dispatch = calls.find(call => call.url.endsWith('/dispatches'));
  assert.equal(dispatch.url, `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`);
  assert.deepEqual(JSON.parse(dispatch.init.body), { ref: BRANCH, inputs: {
    payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest,
  } });
  assert.ok(!dispatch.init.body.includes('literal'));
  for (const call of calls) {
    assert.ok(call.url.startsWith('https://api.github.com/'));
    assert.equal(call.init.headers['X-GitHub-Api-Version'], API_VERSION);
    assert.equal(call.init.headers['User-Agent'], 'seo-yuna-owner');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.ok(call.init.signal instanceof AbortSignal);
    assert.ok(!call.url.includes('Bearer') && !call.url.includes('ghs_'));
  }
  assert.notEqual(blob.init.headers.Authorization, calls[0].init.headers.Authorization);
});

test('every accepted dispatch stays accepted when its run-details body is unavailable', async t => {
  const responses = [
    ['204', () => new Response(null, { status: 204 })],
    ['invalid JSON', () => new Response('not JSON', { status: 200 })],
    ['missing run ID', () => json({})],
    ['invalid run ID', () => json({ workflow_run_id: '../another-repository' })],
    ['null response', () => json(null)],
    ['oversized body', () => new Response('x'.repeat(65537))],
    ['body read interruption', () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('secret in upstream error')); },
    }))],
  ];
  for (const [name, response] of responses) await t.test(name, async () => {
    const { client } = fixture({ repoResponse: () => response() });
    assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: null });
  });
});

test('dispatch connection loss and 5xx are ambiguous and are never automatically replayed', async t => {
  for (const status of [0, 500, 502, 503]) await t.test(String(status), async () => {
    const { client, calls } = fixture({ repoResponse: () => {
      if (!status) throw new Error('PRIVATE KEY and secret in upstream transport error');
      return json({ message: 'PRIVATE KEY and secret in upstream body' }, status);
    } });
    await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError &&
      error.uncertain && !/PRIVATE KEY|secret/.test(error.message));
    assert.equal(calls.filter(call => call.url.endsWith('/dispatches')).length, 1);
  });
});

test('definite dispatch rejection stays distinct from unknown acceptance and sanitizes bodies', async t => {
  for (const status of [401, 403, 404, 409, 422, 429]) await t.test(String(status), async () => {
    const { client, calls } = fixture({ repoResponse: () => json({
      message: 'untrusted secret and https://attacker.example', token: 'credential-leak',
    }, status) });
    await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError &&
      error.status === status && !error.uncertain && !/untrusted|attacker|credential-leak/.test(error.message));
    assert.equal(calls.filter(call => call.url.endsWith('/dispatches')).length, 1);
  });
});

test('authentication transport failures are definite non-submissions', async () => {
  const { client, calls } = fixture({ intercept: () => { throw new Error('private upstream details'); } });
  await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError &&
    !error.uncertain && !error.message.includes('private upstream'));
  assert.ok(!calls.some(call => call.url.endsWith('/dispatches')));
});

test('a rejected token is replaced only on a later explicit call, without replaying a dispatch', async () => {
  let rejected = false;
  const { client, calls, minted } = fixture({ repoResponse: () => {
    if (!rejected) { rejected = true; return json({ message: 'revoked' }, 401); }
    return new Response('[]');
  } });
  await assert.rejects(client.dispatch(receipt), error => error.status === 401 && !error.uncertain);
  assert.equal(minted(), 1);
  assert.equal(calls.filter(call => call.url.endsWith('/dispatches')).length, 1);
  assert.equal(await client.readCanonical(), '[]');
  assert.equal(minted(), 2);
  assert.equal(calls.filter(call => call.url.endsWith('/dispatches')).length, 1);
});

test('a dispatch timeout aborts the request and reports an unknown outcome', async () => {
  const { client, calls } = fixture({ timeoutMs: 10, repoResponse: (_, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('sensitive timeout details')), { once: true });
  }) });
  await assert.rejects(client.dispatch(receipt), error => error instanceof GitHubError && error.uncertain &&
    !error.message.includes('sensitive'));
  const dispatch = calls.find(call => call.url.endsWith('/dispatches'));
  assert.equal(dispatch.init.signal.aborted, true);
  assert.equal(calls.filter(call => call.url.endsWith('/dispatches')).length, 1);
});

test('invalid or unsupported private keys never reach GitHub or leak their contents', async t => {
  const invalidPem = `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(1024)}\n-----END RSA PRIVATE KEY-----`;
  const cases = [
    ['malformed RSA', invalidPem],
    ['encrypted key', privateKey.replaceAll('RSA PRIVATE KEY', 'ENCRYPTED PRIVATE KEY')],
    ['invalid base64', privateKey.replace(/\n./, '\n!')],
    ['multiple PEM blocks', `${privateKey}\n${privateKey}`],
  ];
  for (const [name, pem] of cases) await t.test(name, async () => {
    const { client, calls } = fixture({ clientConfig: { ...config, privateKey: pem } });
    await assert.rejects(client.verifyInstallation(), error => error instanceof GitHubError &&
      !error.uncertain && !error.message.includes('BEGIN') && !error.message.includes('AAAA'));
    assert.equal(calls.length, 0);
  });
  assert.throws(() => new AppGitHubClient({ ...config, privateKey: 'secret'.repeat(10000) }),
    error => error instanceof GitHubError && !error.uncertain && !error.message.includes('secret'));
});

test('invalid IDs, receipts, and oversized UTF-8 uploads fail before authenticating', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.dispatch({ ...receipt, requestId: '../sakura-yuki' }), /incomplete/);
  await assert.rejects(client.dispatch(null), /incomplete/);
  assert.throws(() => client.readRun('../sakura-yuki'), /Invalid/);
  assert.throws(() => client.readJobs('9007199254740992'), /Invalid/);
  await assert.rejects(client.findRun('valid-id', 'not a date'), /Invalid/);
  await assert.rejects(client.stageBlob('あ'.repeat(2 * 1024 * 1024)), /5 MiB/);
  await assert.rejects(client.stageBlob(''), /JSON text/);
  assert.equal(calls.length, 0);
});

test('recovery finds only an exact request ID and keeps branch and pagination bounded', async () => {
  const pages = [];
  const { client } = fixture({ repoResponse: url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, `/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/runs`);
    assert.equal(parsed.searchParams.get('branch'), BRANCH);
    assert.equal(parsed.searchParams.get('event'), 'workflow_dispatch');
    assert.equal(parsed.searchParams.get('created'), '>=2026-10-18T11:55:00.000Z');
    const page = Number(parsed.searchParams.get('page'));
    pages.push(page);
    return json({ workflow_runs: page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, display_title: 'Import unrelated' }))
      : [{ id: 888, display_title: `Import ${receipt.requestId}` }] });
  } });
  assert.equal((await client.findRun(receipt.requestId, new Date(clock).toISOString())).id, 888);
  assert.deepEqual(pages, [1, 2]);
});
