import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerClient, OwnerAccessError, isOwnerStudioContext, OWNER_STUDIO_URL } from '../assets/owner-client.mjs';

const studio = 'https://owner.example.test/studio';
const now = Date.parse('2026-10-18T12:00:00Z');
const csrf = 'test-csrf-'.padEnd(43, 'x');
const session = { authorized: true, configured: true, login: 'budhi-halim', csrfToken: csrf, expiresAt: '2026-10-18T13:00:00Z', installationReady: true };
const receipt = { blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), requestId: '12345678-1234-4123-8123-123456789abc' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const owner = fetchImpl => new OwnerClient({ ownerStudioUrl: studio, location: studio, now: () => now, fetchImpl });

test('native browser fetch retains the global receiver during owner boot and public status reads', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async function (url, init) {
    assert.equal(this, globalThis, 'Window.fetch must not receive a client instance');
    calls.push({ url, init });
    return url.endsWith('/session')
      ? json({ authorized: false, configured: false, installationReady: false })
      : json({ id: 9 });
  });
  const client = new OwnerClient({ ownerStudioUrl: studio, location: studio, now: () => now });
  const result = await client.verifyConnection();
  assert.equal(result.authorized, false);
  assert.equal(client.sessionChecked, true);
  assert.equal(client.configured, false);
  assert.equal(client.setupUrl, 'https://owner.example.test/api/owner/setup');
  assert.equal((await client.readRun(9)).id, 9);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.ok(calls[1].url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
  assert.equal(calls[1].init.headers.Authorization, undefined);
});

test('only the deployed HTTPS origin and exact studio path enable owner API access', () => {
  assert.equal(OWNER_STUDIO_URL, 'https://seo-yuna-owner.halimbudhiarto.chatgpt.site/studio');
  assert.equal(isOwnerStudioContext(`${studio}#import`, studio), true);
  for (const location of ['https://public.example.test/studio', 'https://owner.example.test/', `${studio}/`, 'https://owner.example.test/studio.htm', 'https://owner.example.test.evil/studio']) {
    assert.equal(isOwnerStudioContext(location, studio), false, location);
  }
  for (const config of ['', 'http://owner.example.test/studio', `${studio}?next=elsewhere`, `${studio}#import`, 'https://user:secret@owner.example.test/studio', 'https://owner.example.test/not-studio.html']) {
    assert.equal(isOwnerStudioContext(studio, config), false, config);
  }
});

test('public mode never probes owner sessions or allows a write', async () => {
  let calls = 0;
  const client = new OwnerClient({ ownerStudioUrl: studio, location: 'https://budhi-halim.github.io/seo-yuna/', fetchImpl: async () => { calls += 1; assert.fail('must not fetch'); } });
  assert.equal((await client.verifyConnection()).authorized, false);
  assert.equal(client.ownerContext, false);
  assert.equal(client.connected, false);
  assert.equal(client.loginUrl, '');
  assert.equal(client.setupUrl, '');
  assert.throws(() => { client.connected = true; }, TypeError);
  await assert.rejects(client.stageBlob('[]'), error => error.status === 403);
  await assert.rejects(client.dispatch(receipt), error => error.status === 403);
  assert.equal(calls, 0);
});

test('a verified owner session keeps CSRF private and sends it only to fixed same-origin mutations', async () => {
  const calls = [];
  const client = owner(async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/session')) return json(session);
    if (url.endsWith('/catalog')) return new Response('[]');
    if (url.endsWith('/stage')) return json({ sha: receipt.blobSha });
    return json({ accepted: true, runId: 42 });
  });
  const verified = await client.verifyConnection();
  assert.equal(client.connected, true);
  assert.equal(client.login, 'budhi-halim');
  assert.equal(client.loginUrl, 'https://owner.example.test/api/owner/auth/login');
  assert.equal(client.setupUrl, 'https://owner.example.test/api/owner/setup/install');
  assert.equal(verified.csrfToken, undefined);
  assert.deepEqual(Object.keys(client), []);
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(await client.readCanonical(), '[]');
  assert.equal(await client.stageBlob('[{"literal":"<script>"}]'), receipt.blobSha);
  assert.deepEqual(await client.dispatch({ ...receipt, detail: 'discard this extra property' }), { accepted: true, runId: 42 });
  for (const { url, init } of calls) {
    assert.ok(url.startsWith('https://owner.example.test/api/owner/'));
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['X-CSRF-Token'], init.method === 'POST' ? csrf : undefined);
    assert.equal(url.includes(csrf), false);
  }
  assert.equal(calls[2].init.body, '[{"literal":"<script>"}]');
  assert.deepEqual(JSON.parse(calls[3].init.body), receipt);
});

test('signed-out 401 is a normal state while configured metadata remains available', async () => {
  const client = owner(async () => json({ authorized: false, configured: true, installationReady: true }, 401));
  assert.equal((await client.verifyConnection()).authorized, false);
  assert.equal(client.sessionChecked, true);
  assert.equal(client.configured, true);
  assert.equal(client.connected, false);
  assert.equal(client.login, null);
  const empty = owner(async () => new Response(null, { status: 401 }));
  await empty.verifyConnection();
  assert.equal(empty.configured, false);
  assert.equal(empty.connected, false);
});

test('malformed, wrong-owner, expired, or incomplete authorization fails closed', async () => {
  const badSessions = [null, [], {}, { ...session, authorized: 'true' }, { ...session, configured: 'true' },
    { ...session, login: 'someone-else' }, { ...session, csrfToken: 'short' }, { ...session, csrfToken: 'x'.repeat(40) + '\n' },
    { ...session, expiresAt: '2026-10-18T11:59:59Z' }, { ...session, expiresAt: 'invalid' }, { ...session, installationReady: 'true' },
    { ...session, configured: undefined }, { ...session, installationReady: undefined }];
  for (const bad of badSessions) {
    const client = owner(async () => json(bad));
    await assert.rejects(client.verifyConnection(), OwnerAccessError);
    assert.equal(client.connected, false);
    assert.equal(client.authorized, false);
  }
  const false401 = owner(async () => json(session, 401));
  await assert.rejects(false401.verifyConnection(), OwnerAccessError);
  assert.equal(false401.connected, false);
});

test('an authenticated account cannot write before app configuration and installation are ready', async () => {
  for (const incomplete of [{ ...session, configured: false }, { ...session, installationReady: false }]) {
    const client = owner(async () => json(incomplete));
    await client.verifyConnection();
    assert.equal(client.authorized, true);
    assert.equal(client.connected, false);
    assert.equal(client.loginUrl, '');
    assert.equal(client.setupUrl, incomplete.configured ? 'https://owner.example.test/api/owner/setup/install' : 'https://owner.example.test/api/owner/setup');
    await assert.rejects(client.stageBlob('[]'), /Complete the GitHub connection/);
  }
});

test('server epoch-millisecond expiries are accepted without exposing CSRF', async () => {
  const client = owner(async () => json({ ...session, expiresAt: Date.parse(session.expiresAt) }));
  const verified = await client.verifyConnection();
  assert.equal(client.connected, true);
  assert.equal(verified.expiresAt, '2026-10-18T13:00:00.000Z');
  assert.equal(verified.csrfToken, undefined);
});

test('session expiry and page-context changes immediately close the write path', async () => {
  let clock = now;
  const location = { href: studio };
  const client = new OwnerClient({ ownerStudioUrl: studio, location, now: () => clock, fetchImpl: async () => json(session) });
  await client.verifyConnection();
  assert.equal(client.connected, true);
  clock = Date.parse(session.expiresAt);
  assert.equal(client.connected, false);
  clock = now;
  location.href = 'https://owner.example.test/';
  assert.equal(client.connected, false);
  await assert.rejects(client.dispatch(receipt), /configured owner studio/);
});

test('a stale session response cannot reconnect after local disconnect', async () => {
  let resolve;
  const client = owner(() => new Promise(done => { resolve = done; }));
  const verification = client.verifyConnection();
  client.disconnect();
  resolve(json(session));
  await verification;
  assert.equal(client.connected, false);
  assert.equal(client.login, null);
});

test('network loss during dispatch is uncertain, redacted, and never replayed', async () => {
  let dispatches = 0;
  const client = owner(async url => {
    if (url.endsWith('/session')) return json(session);
    dispatches += 1;
    throw new Error('upstream secret browser-cookie client-secret');
  });
  await client.verifyConnection();
  await assert.rejects(client.dispatch(receipt), error => error instanceof OwnerAccessError && error.uncertain && !error.message.includes('secret'));
  assert.equal(dispatches, 1);
});

test('acceptance stays unknown for missing or malformed responses; a confirmed runless acceptance is recoverable', async () => {
  for (const response of [new Response(null, { status: 204 }), new Response('bad secret json'), json({ accepted: 'true', runId: 1 })]) {
    const client = owner(async url => url.endsWith('/session') ? json(session) : response);
    await client.verifyConnection();
    await assert.rejects(client.dispatch(receipt), error => error.uncertain && !error.message.includes('secret'));
  }
  const client = owner(async url => url.endsWith('/session') ? json(session) : json({ accepted: true, runId: 'javascript:bad' }));
  await client.verifyConnection();
  assert.deepEqual(await client.dispatch(receipt), { accepted: true, runId: null });
});

test('definite rejections do not expose upstream bodies or remain connected after authorization failure', async () => {
  const client = owner(async url => url.endsWith('/session') ? json(session) : json({ message: 'secret private response' }, 403));
  await client.verifyConnection();
  await assert.rejects(client.dispatch(receipt), error => error.status === 403 && !error.uncertain && !error.message.includes('secret'));
  assert.equal(client.connected, false);
  const unavailable = owner(async url => url.endsWith('/session') ? json(session) : json({ message: 'secret response' }, 502));
  await unavailable.verifyConnection();
  await assert.rejects(unavailable.dispatch(receipt), error => error.uncertain && !error.message.includes('secret'));
});

test('explicit server uncertainty is preserved for 409 and definite 5xx errors without leaking error text', async () => {
  for (const [status, uncertain] of [[409, true], [502, false]]) {
    const client = owner(async url => url.endsWith('/session') ? json(session) : json({ error: 'secret upstream body', code: 'secret code', uncertain }, status));
    await client.verifyConnection();
    await assert.rejects(client.dispatch(receipt), error => error.status === status && error.uncertain === uncertain && !error.message.includes('secret'));
  }
});

test('redirected response adapters cannot establish owner authorization', async () => {
  const response = json(session);
  Object.defineProperty(response, 'url', { value: 'https://other.example.test/api/owner/session' });
  const client = owner(async () => response);
  await assert.rejects(client.verifyConnection(), /untrusted redirect/);
  assert.equal(client.connected, false);
});

test('run status uses authenticated server paths for the owner and anonymous GitHub for public readers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/session')) return json(session);
    if (url.includes('/runs?')) return json(null);
    return json({ id: 9, jobs: [] });
  };
  const client = owner(fetchImpl);
  await client.verifyConnection();
  await client.readRun(9); await client.readJobs(9); await client.findRun(receipt.requestId, '2026-10-18T12:00:00Z');
  assert.equal(calls[1].url, 'https://owner.example.test/api/owner/runs/9');
  assert.equal(calls[2].url, 'https://owner.example.test/api/owner/runs/9/jobs');
  assert.equal(new URL(calls[3].url).searchParams.get('request_id'), receipt.requestId);
  client.disconnect();
  await client.readRun(9);
  const publicCall = calls.at(-1);
  assert.ok(publicCall.url.startsWith('https://api.github.com/repos/budhi-halim/seo-yuna/'));
  assert.equal(publicCall.init.headers.Authorization, undefined);
  assert.equal(publicCall.init.headers['X-CSRF-Token'], undefined);
});

test('invalid receipt and run inputs cannot change request destinations', async () => {
  let calls = 0;
  const client = owner(async () => { calls += 1; return json(session); });
  await client.verifyConnection();
  await assert.rejects(client.dispatch({ ...receipt, requestId: '../elsewhere' }), /incomplete/);
  await assert.rejects(client.dispatch({ ...receipt, requestId: 'batch-123' }), /incomplete/);
  await assert.rejects(client.readRun('https://evil.example/1'), /Invalid/);
  await assert.rejects(client.readJobs('../session'), /Invalid/);
  await assert.rejects(client.findRun('x&leak=1', '2026-10-18T12:00:00Z'), /Invalid/);
  await assert.rejects(client.findRun(receipt.requestId, 'not-a-date'), /Invalid/);
  assert.equal(calls, 1);
});

test('owner reconciliation cannot mark an unrelated workflow as this submission', async () => {
  let result = { id: 19, display_title: 'Import unrelated' };
  const client = owner(async url => url.endsWith('/session') ? json(session) : json(result));
  await client.verifyConnection();
  await assert.rejects(client.findRun(receipt.requestId, '2026-10-18T12:00:00Z'), /could not be verified/);
  result = { id: 21, display_title: `Import ${receipt.requestId}` };
  assert.equal((await client.findRun(receipt.requestId, '2026-10-18T12:00:00Z')).id, 21);
});

test('logout posts the CSRF value and clears local authorization only after success', async () => {
  let logout;
  const client = owner(async (url, init) => {
    if (url.endsWith('/session')) return json(session);
    logout = { url, init };
    return new Response(null, { status: 204 });
  });
  await client.verifyConnection();
  await client.logout();
  assert.equal(logout.url, 'https://owner.example.test/api/owner/auth/logout');
  assert.equal(logout.init.headers['X-CSRF-Token'], csrf);
  assert.equal(logout.init.credentials, 'same-origin');
  assert.equal(client.connected, false);
});
