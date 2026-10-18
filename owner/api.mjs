import { AuthService, AuthError, authErrorResponse } from './auth.mjs';
import { handleSetup } from './setup.mjs';
import { GitHubClient, GitHubError } from '../assets/github.mjs';
import { CatalogError, MAX_IMPORT_BYTES, parseCatalog, validateCatalog, mergeCatalog } from '../assets/catalog.mjs';

const OWNER_ID = 121861881;
const MAX_CANONICAL_BYTES = 16 * 1024 * 1024;
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

/** GitHub requires User-Agent on server requests. Bound response streams before
 * the shared client buffers JSON, reserving Worker memory for parsing/merging. */
export function createServerGitHubFetch(fetchImpl = globalThis.fetch) {
  return async function serverGitHubFetch(url, options = {}) {
    const headers = new Headers(options.headers);
    headers.set('User-Agent', 'seo-yuna-owner');
    const response = await fetchImpl.call(globalThis, url, { ...options, headers });
    const maximum = String(url).includes('/contents/data.json?') ? MAX_CANONICAL_BYTES : 8 * 1024 * 1024;
    const declared = response.headers.get('Content-Length');
    if (declared && Number(declared) > maximum) {
      await response.body?.cancel();
      throw new GitHubError('GitHub returned a response larger than the supported limit.', 502);
    }
    if (!response.body) return response;
    let received = 0;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maximum) {
          controller.error(new Error('GitHub response limit exceeded.'));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class OwnerAPIError extends Error {
  constructor(message, status = 400, { code = 'invalid_request', uncertain = false } = {}) {
    super(message);
    this.name = 'OwnerAPIError';
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status });
}

async function navigationResponse(response) {
  if (response.status < 400) return response;
  let message = 'GitHub sign-in could not finish. Return to the owner studio and try again.';
  try {
    const value = await response.json();
    if (typeof value.error === 'string' && value.error.length < 1000) message = value.error;
  } catch { /* Keep a safe, actionable message when a response is unavailable. */ }
  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/style.css"><title>GitHub sign-in · Seo Yuna</title></head><body class="owner-auth-page"><main class="owner-auth-card"><p class="owner-auth-brand">SEO YUNA · OWNER STUDIO</p><h1>GitHub sign-in</h1><p>${escape(message)}</p><a class="button button-primary" href="/studio#import">Return to owner studio</a></main></body></html>`,
    { status: response.status, headers });
}

function secured(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  if (headers.get('Content-Type')?.includes('application/json')) {
    headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  return new Response(response.body, { status: response.status, headers });
}

function errorResponse(error) {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof CatalogError) {
    return json({ error: error.message, code: error.code, uncertain: false }, 422);
  }
  if (error instanceof OwnerAPIError) {
    return json({ error: error.message, code: error.code, uncertain: error.uncertain }, error.status);
  }
  if (error instanceof GitHubError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return json({ error: error.message, code: 'github_request_failed', uncertain: false }, status);
  }
  // Never include upstream bodies, request URLs, credential objects, or stack traces.
  return json({ error: 'The owner service could not complete this request. Try again shortly.', code: 'service_unavailable', uncertain: false }, 503);
}

export async function readJSONText(request, limit = MAX_IMPORT_BYTES) {
  if (!JSON_TYPE.test(request.headers.get('Content-Type') ?? '')) {
    throw new OwnerAPIError('Send one JSON document with Content-Type application/json.', 415);
  }
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new OwnerAPIError('The JSON upload exceeds the allowed size.', 413);
  }
  if (!request.body) throw new OwnerAPIError('The JSON body is empty.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new OwnerAPIError('The JSON upload exceeds the allowed size.', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new OwnerAPIError('The JSON must be encoded as UTF-8.'); }
}

async function hash(text, cryptoImpl) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function canonical(source) {
  if (typeof source !== 'string' || encoder.encode(source).byteLength > MAX_CANONICAL_BYTES) {
    throw new OwnerAPIError('The canonical collection exceeds the supported size.', 502);
  }
  try { return validateCatalog(JSON.parse(source)); }
  catch { throw new OwnerAPIError('The current data.json could not be validated. Check the repository before importing.', 502); }
}

function receipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 || !UUID.test(value.requestId ?? '') ||
      !SHA1.test(value.blobSha ?? '') || !SHA256.test(value.digest ?? '')) {
    throw new OwnerAPIError('The submission receipt is invalid. Validate and upload the JSON again.');
  }
  return { requestId: value.requestId, blobSha: value.blobSha, digest: value.digest };
}

async function stage(request, session, client, env, cryptoImpl, now) {
  const source = await readJSONText(request);
  const incoming = parseCatalog(source);
  if (!incoming.length || incoming.some(theme => !theme.variations.length)) {
    throw new OwnerAPIError('Each upload must contain at least one theme, and each theme must contain a variation.', 422);
  }
  const latest = canonical(await client.readCanonical());
  const result = mergeCatalog(latest, incoming);
  if (encoder.encode(JSON.stringify(result.catalog)).byteLength > MAX_CANONICAL_BYTES) {
    throw new OwnerAPIError('This batch would exceed the supported collection size.', 413);
  }
  const digest = await hash(source, cryptoImpl);
  const sha = await client.stageBlob(source);
  if (!SHA1.test(sha ?? '')) throw new OwnerAPIError('GitHub did not return a valid upload receipt.', 502);
  await env.DB.prepare(`INSERT INTO staged_uploads (blob_sha, digest, owner_id, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(blob_sha) DO UPDATE SET created_at = excluded.created_at
    WHERE staged_uploads.digest = excluded.digest AND staged_uploads.owner_id = excluded.owner_id`)
    .bind(sha, digest, session.user.id, now()).run();
  return json({ sha });
}

async function dispatch(request, session, client, env, now) {
  let value;
  try { value = JSON.parse(await readJSONText(request, 2048)); }
  catch (error) {
    if (error instanceof OwnerAPIError) throw error;
    throw new OwnerAPIError('The submission receipt must be valid JSON.');
  }
  const record = receipt(value);
  const staged = await env.DB.prepare('SELECT digest, owner_id FROM staged_uploads WHERE blob_sha = ?')
    .bind(record.blobSha).first();
  if (!staged || staged.digest !== record.digest || staged.owner_id !== session.user.id) {
    throw new OwnerAPIError('This upload was not validated by the owner studio. Select or paste the JSON again.', 409);
  }

  // Claim the unique request before contacting GitHub. An interrupted dispatch is
  // reconciled by its exact run title; the server never automatically replays it.
  const claimed = await env.DB.prepare(`INSERT INTO import_requests
    (request_id, blob_sha, digest, owner_id, state, run_id, created_at)
    VALUES (?, ?, ?, ?, 'pending', NULL, ?) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`)
    .bind(record.requestId, record.blobSha, record.digest, session.user.id, now()).first();
  if (!claimed) {
    const previous = await env.DB.prepare('SELECT blob_sha, digest, owner_id, state, run_id FROM import_requests WHERE request_id = ?')
      .bind(record.requestId).first();
    if (previous?.owner_id !== session.user.id || previous.blob_sha !== record.blobSha || previous.digest !== record.digest) {
      throw new OwnerAPIError('This submission reference is already in use.', 409);
    }
    if (previous.state === 'accepted') return json({ accepted: true, runId: previous.run_id ?? null });
    throw new OwnerAPIError('This request was already attempted. Check Activity for its GitHub run before making an explicit retry.', 409,
      { code: 'already_attempted', uncertain: previous.state !== 'rejected' });
  }

  let result;
  try { result = await client.dispatch(record); }
  catch (error) {
    const uncertain = !(error instanceof GitHubError) || error.uncertain;
    try {
      await env.DB.prepare('UPDATE import_requests SET state = ? WHERE request_id = ?')
        .bind(uncertain ? 'unknown' : 'rejected', record.requestId).run();
    } catch { /* The durable pending claim still prevents automatic replay. */ }
    throw new OwnerAPIError(error instanceof GitHubError ? error.message : 'The connection ended before GitHub acceptance could be confirmed. Check Activity before retrying.',
      error instanceof GitHubError && error.status >= 400 ? error.status : 502,
      { code: 'dispatch_failed', uncertain });
  }
  if (result?.accepted !== true) {
    throw new OwnerAPIError('GitHub acceptance could not be confirmed. Check Activity before retrying.', 502,
      { code: 'dispatch_unconfirmed', uncertain: true });
  }
  const runId = Number.isSafeInteger(result.runId) && result.runId > 0 ? result.runId : null;
  try {
    await env.DB.prepare("UPDATE import_requests SET state = 'accepted', run_id = ? WHERE request_id = ?")
      .bind(runId, record.requestId).run();
  } catch { /* A confirmed GitHub acceptance is enough to close the browser safely. */ }
  return json({ accepted: true, runId });
}

/** Only these fixed routes and the fixed Seo Yuna repository are reachable. */
export function createOwnerHandler({ env, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
  now = Date.now, authFactory, githubClientFactory, setupHandler = handleSetup } = {}) {
  return async function handleOwnerRequest(request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.APP_ORIGIN) throw new OwnerAPIError('This request has the wrong origin.', 403);
      const setup = await setupHandler(request, { env, fetchImpl, cryptoImpl, now });
      if (setup) return secured(setup);
      const path = url.pathname;
      const route = {
        '/api/owner/session': ['GET', 'handleSession'],
        '/api/owner/auth/login': ['GET', 'login'],
        '/api/owner/oauth/callback': ['GET', 'callback'],
        '/api/owner/auth/logout': ['POST', 'logout'],
      }[path];
      const auth = authFactory ? authFactory() : new AuthService({ env, fetchImpl, cryptoImpl, now });
      if (route) {
        if (request.method !== route[0]) throw new OwnerAPIError('This method is not allowed.', 405);
        const response = await auth[route[1]](request);
        return secured(['login', 'callback'].includes(route[1]) ? await navigationResponse(response) : response);
      }
      let method;
      if (path === '/api/owner/catalog' || path === '/api/owner/runs' || /^\/api\/owner\/runs\/[1-9]\d*(?:\/jobs)?$/.test(path)) method = 'GET';
      if (path === '/api/owner/stage' || path === '/api/owner/dispatch') method = 'POST';
      if (!method) throw new OwnerAPIError('This endpoint does not exist.', 404);
      if (request.method !== method) throw new OwnerAPIError('This method is not allowed.', 405);
      const session = await auth.authenticate(request, { write: method === 'POST' });
      if (session?.user?.id !== OWNER_ID || session.user.login !== 'budhi-halim' || !session.token) {
        throw new OwnerAPIError('Only budhi-halim can access owner operations.', 403);
      }
      const client = githubClientFactory ? githubClientFactory(session.token) : new GitHubClient(session.token, createServerGitHubFetch(fetchImpl));
      let response;
      if (path === '/api/owner/catalog') {
        const source = await client.readCanonical();
        canonical(source);
        response = new Response(source, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      } else if (path === '/api/owner/stage') response = await stage(request, session, client, env, cryptoImpl, now);
      else if (path === '/api/owner/dispatch') response = await dispatch(request, session, client, env, now);
      else if (path === '/api/owner/runs') {
        if ([...url.searchParams.keys()].some(key => !['request_id', 'created_at'].includes(key)) ||
            url.searchParams.getAll('request_id').length !== 1 || url.searchParams.getAll('created_at').length !== 1) {
          throw new OwnerAPIError('The run lookup is invalid.');
        }
        const requestId = url.searchParams.get('request_id');
        const createdAt = url.searchParams.get('created_at');
        if (!UUID.test(requestId ?? '') || (createdAt?.length ?? 0) > 40 || !Number.isFinite(Date.parse(createdAt))) {
          throw new OwnerAPIError('The run lookup reference or date is invalid.');
        }
        response = json(await client.findRun(requestId, createdAt));
      } else {
        const id = Number(path.split('/')[4]);
        if (!Number.isSafeInteger(id)) throw new OwnerAPIError('The workflow run ID is invalid.');
        response = json(path.endsWith('/jobs') ? await client.readJobs(id) : await client.readRun(id));
      }
      return secured(response);
    } catch (error) { return secured(errorResponse(error)); }
  };
}
