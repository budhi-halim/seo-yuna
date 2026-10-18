import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../owner/sites-data-route.ts';

test('owner reader loads the published catalog using Worker-compatible redirect handling', async t => {
  const content = '[{"id":"fixture","name":"Fixture","variations":[]}]';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.redirect === 'error') throw new TypeError('Unsupported Worker redirect mode');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    calls.push(url);
    return new Response(content);
  });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), content);
  assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
  assert.deepEqual(calls, ['https://budhi-halim.github.io/seo-yuna/data.json']);
});

test('owner reader rejects an upstream redirect and never requests its destination', async t => {
  const calls = [];
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    calls.push(url);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { Location: 'https://untrusted.example.test/' },
    });
  });
  const response = await GET();
  assert.equal(response.status, 502);
  assert.equal(cancelled, true);
  assert.deepEqual(calls, ['https://budhi-halim.github.io/seo-yuna/data.json']);
  assert.doesNotMatch(await response.text(), /untrusted/);
});

test('owner reader returns a safe retry message when the upstream request fails', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private upstream error'); });
  const response = await GET();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.match(body.error, /Refresh to try again/);
  assert.doesNotMatch(body.error, /private upstream/);
});
