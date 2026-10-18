/** GitHub-only authentication. Call from a trusted server; never bundle this module for browsers. */
import { OWNER, OWNER_ID, REPOSITORY, REPOSITORY_ID, BRANCH, API_VERSION } from './github-app.mjs';

export const SESSION_COOKIE = '__Host-seo_yuna_session';
export const OAUTH_COOKIE = '__Host-seo_yuna_oauth';
export const OAUTH_CALLBACK_PATH = '/api/owner/oauth/callback';
const STUDIO_PATH = '/studio#import';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 8 * 60 * 60 * 1000;
const MAX_PLAINTEXT = 64 * 1024;
const MAX_ENVELOPE = 96 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CONFIG_KEYS = ['appId', 'clientId', 'clientSecret', 'privateKey', 'slug', 'installationId', 'installationMetadata'];
const METADATA_KEYS = ['appId', 'installationId', 'slug', 'ownerId', 'owner', 'repositoryId', 'repository'];

export class AuthError extends Error {
  constructor(message, status = 503, code = 'authentication_unavailable') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status = 503, code = 'authentication_unavailable') {
  throw new AuthError(message, status, code);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function positiveId(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9][0-9]{0,15}$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length % 4 ||
      value.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('Stored authentication data is invalid. Reconnect to GitHub.');
  }
  try {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    if (bytes.length < minimum || bytes.length > maximum || base64(bytes) !== value) {
      bytes.fill(0);
      fail('Stored authentication data is invalid. Reconnect to GitHub.');
    }
    return bytes;
  } catch {
    fail('Stored authentication data is invalid. Reconnect to GitHub.');
  }
}

function base64url(bytes) {
  return base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function additionalData(purpose) {
  if (typeof purpose !== 'string' || !/^[a-z][a-z0-9:-]{0,99}$/.test(purpose)) {
    fail('The server could not initialize authentication storage.');
  }
  return encoder.encode(`seo-yuna:server-secret:v1\0${REPOSITORY}\0${purpose}`);
}

async function encryptionKey(key, cryptoImpl) {
  let bytes;
  try {
    bytes = unbase64(key, 32, 32);
    return await cryptoImpl.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch {
    fail('The server’s authentication encryption key is unavailable.');
  } finally {
    bytes?.fill(0);
  }
}

export function randomToken(cryptoImpl = globalThis.crypto, byteLength = 32) {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    fail('The server could not generate an authentication reference.');
  }
  try {
    return base64url(cryptoImpl.getRandomValues(new Uint8Array(byteLength)));
  } catch {
    fail('The server could not generate an authentication reference.');
  }
}

export async function sha256(text, cryptoImpl = globalThis.crypto) {
  if (typeof text !== 'string' || text.length > MAX_PLAINTEXT) fail('Invalid authentication reference.');
  try {
    const bytes = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', encoder.encode(text)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    fail('The server could not verify an authentication reference.');
  }
}

/** JSON envelope; the repository, format version, purpose, and caller-supplied row ID are authenticated. */
export async function seal(value, key, purpose, cryptoImpl = globalThis.crypto) {
  let bytes;
  try {
    const aad = additionalData(purpose);
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > MAX_PLAINTEXT) fail('Authentication data exceeds its supported size.');
    bytes = encoder.encode(text);
    if (bytes.length > MAX_PLAINTEXT) fail('Authentication data exceeds its supported size.');
    const imported = await encryptionKey(key, cryptoImpl);
    const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, imported, bytes);
    return JSON.stringify({ version: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    fail('The server could not protect authentication data.');
  } finally {
    bytes?.fill(0);
  }
}

export async function open(envelope, key, purpose, cryptoImpl = globalThis.crypto) {
  let plaintext;
  try {
    const aad = additionalData(purpose);
    if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE) fail('Stored authentication data is invalid. Reconnect to GitHub.');
    const value = JSON.parse(envelope);
    if (!object(value) || Object.keys(value).length !== 3 ||
        Object.keys(value).some(name => !['version', 'iv', 'ciphertext'].includes(name)) || value.version !== 1) {
      fail('Stored authentication data is invalid. Reconnect to GitHub.');
    }
    const iv = unbase64(value.iv, 12, 12);
    const ciphertext = unbase64(value.ciphertext, 17, MAX_PLAINTEXT + 16);
    const imported = await encryptionKey(key, cryptoImpl);
    plaintext = new Uint8Array(await cryptoImpl.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, imported, ciphertext));
    if (plaintext.length > MAX_PLAINTEXT) fail('Stored authentication data is invalid. Reconnect to GitHub.');
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    fail('Stored authentication data could not be verified. Reconnect to GitHub.');
  } finally {
    plaintext?.fill(0);
  }
}

export function validateAppConfig(value) {
  if (!object(value) || Object.keys(value).some(name => !CONFIG_KEYS.includes(name)) ||
      !positiveId(value.appId) || typeof value.clientId !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(value.clientId) ||
      typeof value.clientSecret !== 'string' || !/^[A-Za-z0-9_.-]{1,512}$/.test(value.clientSecret) ||
      typeof value.privateKey !== 'string' || value.privateKey.length < 512 || value.privateKey.length > 32768 ||
      typeof value.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value.slug) ||
      (value.installationId != null && !positiveId(value.installationId))) {
    fail('The saved GitHub App configuration is incomplete. Complete app setup again.');
  }
  const result = { appId: positiveId(value.appId), clientId: value.clientId, clientSecret: value.clientSecret,
    privateKey: value.privateKey, slug: value.slug, installationId: positiveId(value.installationId) };
  if (value.installationMetadata !== undefined) {
    const metadata = value.installationMetadata;
    if (!object(metadata) || Object.keys(metadata).length !== METADATA_KEYS.length ||
        Object.keys(metadata).some(name => !METADATA_KEYS.includes(name)) ||
        positiveId(metadata.appId) !== result.appId || positiveId(metadata.installationId) !== result.installationId ||
        !result.installationId || metadata.slug !== result.slug || positiveId(metadata.ownerId) !== OWNER_ID ||
        metadata.owner !== OWNER || positiveId(metadata.repositoryId) !== REPOSITORY_ID || metadata.repository !== REPOSITORY) {
      fail('The saved GitHub App installation does not match seo-yuna. Complete app setup again.');
    }
    result.installationMetadata = { appId: result.appId, installationId: result.installationId, slug: result.slug,
      ownerId: OWNER_ID, owner: OWNER, repositoryId: REPOSITORY_ID, repository: REPOSITORY };
  }
  return result;
}

async function database(env, sql, bindings, method = 'first') {
  try {
    const result = await env.DB.prepare(sql).bind(...bindings)[method]();
    if (result?.success === false) throw new Error('Database operation failed');
    return result;
  } catch {
    fail('Authentication storage is temporarily unavailable. Please try again.');
  }
}

export async function getAppConfig(env, { cryptoImpl = globalThis.crypto } = {}) {
  const row = await database(env, "SELECT payload FROM app_config WHERE id = 'github_app'", []);
  if (!row) return null;
  return validateAppConfig(await open(row.payload, env.APP_CREDENTIAL_KEY, 'app-config', cryptoImpl));
}

function privateHeaders(extra) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Vary', 'Cookie');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function jsonResponse(value, status = 200, extra) {
  const headers = privateHeaders(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { status, headers });
}

export function authErrorResponse(error) {
  const known = error instanceof AuthError;
  // Authentication fails before an import can be dispatched. Make that explicit
  // so a 5xx identity-check failure does not become an ambiguous submission.
  return jsonResponse({ error: known ? error.message : 'Authentication is temporarily unavailable. Please try again.',
    code: known ? error.code : 'authentication_unavailable', uncertain: false }, known ? error.status : 503);
}

function cookieValue(request, name) {
  const header = request.headers.get('cookie') ?? '';
  if (header.length > 16384) return null;
  const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function equalToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== 43 || right.length !== 43) return false;
  let difference = 0;
  for (let index = 0; index < 43; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function cookie(name, value, expiresAt, now) {
  const age = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}; Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearCookie(name) {
  return cookie(name, '', 0, 0);
}

function redirect(location, cookies = []) {
  const headers = privateHeaders({ Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 302, headers });
}

function userToken(value) {
  return typeof value === 'string' && /^ghu_[A-Za-z0-9._-]{1,16380}$/.test(value);
}

function publicSession(config, session = null) {
  return { authorized: session !== null, configured: config !== null,
    installationReady: Boolean(config?.installationId), login: session?.user.login ?? null,
    csrfToken: session?.csrfToken ?? null,
    expiresAt: session ? new Date(session.expiresAt).toISOString() : null };
}

/** A request-scoped service. All GitHub credentials remain in private return values/server storage. */
export class AuthService {
  #env;
  #fetch;
  #crypto;
  #now;
  #origin;
  #timeout;
  #configPromise;

  constructor({ env, fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
    now = Date.now, timeoutMs = 20000 } = {}) {
    let origin;
    try {
      origin = new URL(env.APP_ORIGIN);
      if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN ||
          origin.username || origin.password || !env.DB?.prepare || typeof env.APP_CREDENTIAL_KEY !== 'string' ||
          typeof fetchImpl !== 'function' || !cryptoImpl?.subtle || !cryptoImpl?.getRandomValues ||
          typeof now !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid server setup');
    } catch {
      fail('GitHub sign-in is not configured on this server.', 503, 'setup_required');
    }
    this.#env = env;
    this.#fetch = fetchImpl.bind(globalThis);
    this.#crypto = cryptoImpl;
    this.#now = now;
    this.#origin = origin.origin;
    this.#timeout = timeoutMs;
  }

  #clock() {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value <= 0) fail('The server clock is unavailable.');
    return value;
  }

  #config() {
    this.#configPromise ??= getAppConfig(this.#env, { cryptoImpl: this.#crypto });
    return this.#configPromise;
  }

  #request(request, method) {
    let url;
    try { url = new URL(request.url); } catch { fail('Invalid sign-in request.', 400, 'invalid_request'); }
    if (url.origin !== this.#origin) fail('This request was sent to an unexpected origin.', 403, 'invalid_origin');
    if (method && request.method !== method) fail('This request method is not supported.', 405, 'invalid_method');
    return url;
  }

  #writeOrigin(request) {
    this.#request(request, 'POST');
    if (request.headers.get('origin') !== this.#origin) {
      fail('The request did not originate from this app. Reload the app and try again.', 403, 'invalid_origin');
    }
  }

  #csrf(request, session) {
    if (!equalToken(request.headers.get('x-csrf-token'), session.csrfToken)) {
      fail('The page’s security check expired. Reload the app and try again.', 403, 'invalid_csrf');
    }
  }

  async #endpoint(action) {
    try { return await action(); } catch (error) { return authErrorResponse(error); }
  }

  async #github(url, { token, body } = {}) {
    if (!(url === 'https://github.com/login/oauth/access_token' || url === 'https://api.github.com/user' ||
        url === `https://api.github.com/repos/${REPOSITORY}`)) fail('Invalid GitHub authentication destination.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(url, {
        // Workers support manual/follow; manual keeps OAuth secrets and user tokens on the fixed endpoint.
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual', cache: 'no-store', signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'seo-yuna-owner',
          'X-GitHub-Api-Version': API_VERSION,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Never inspect upstream error bodies. */ }
        if (response.status >= 300 && response.status < 400) {
          fail('GitHub returned an unexpected sign-in redirect. Start sign-in again.', 502, 'github_redirect_rejected');
        }
        if (response.status === 401) fail('Your GitHub session is no longer valid. Sign in again.', 401, 'authentication_required');
        if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
          fail('GitHub is limiting requests. Wait before trying again.', 429, 'rate_limited');
        }
        if (response.status === 403) fail('GitHub denied the account check. Sign in again.', 403, 'account_denied');
        if (response.status === 404) fail('GitHub could not verify access to seo-yuna. Check the app installation.', 403, 'repository_denied');
        fail('GitHub could not complete sign-in. Please try again.', 502, 'github_unavailable');
      }
      const maximum = 128 * 1024;
      if (Number(response.headers.get('content-length')) > maximum) fail('GitHub returned an invalid sign-in response.', 502, 'invalid_github_response');
      let text = '';
      let size = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const textDecoder = new TextDecoder('utf-8', { fatal: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maximum) fail('GitHub returned an invalid sign-in response.', 502, 'invalid_github_response');
            text += textDecoder.decode(chunk.value, { stream: true });
          }
          text += textDecoder.decode();
        } catch (error) {
          try { await reader.cancel(); } catch { /* Keep the sanitized failure. */ }
          throw error;
        } finally { reader.releaseLock(); }
      } else {
        text = await response.text();
        if (encoder.encode(text).length > maximum) fail('GitHub returned an invalid sign-in response.', 502, 'invalid_github_response');
      }
      const result = JSON.parse(text);
      if (!object(result) || result.error) fail('GitHub could not complete sign-in. Start sign-in again.', 400, 'github_signin_rejected');
      return result;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      fail('The connection to GitHub was interrupted. Try signing in again.', 502, 'github_unavailable');
    } finally { clearTimeout(timer); }
  }

  async #identify(token) {
    const user = await this.#github('https://api.github.com/user', { token });
    if (positiveId(user.id) !== OWNER_ID || typeof user.login !== 'string' || user.login.toLowerCase() !== OWNER) {
      fail('Only the budhi-halim GitHub account can import into this collection.', 403, 'owner_required');
    }
    return { id: OWNER_ID, login: OWNER };
  }

  async #checkRepository(token) {
    const repo = await this.#github(`https://api.github.com/repos/${REPOSITORY}`, { token });
    if (positiveId(repo.id) !== REPOSITORY_ID || typeof repo.full_name !== 'string' ||
        repo.full_name.toLowerCase() !== REPOSITORY || positiveId(repo.owner?.id) !== OWNER_ID ||
        typeof repo.owner?.login !== 'string' || repo.owner.login.toLowerCase() !== OWNER ||
        repo.default_branch !== BRANCH || repo.permissions?.push !== true) {
      fail('This GitHub connection must have write access to budhi-halim/seo-yuna on master.', 403, 'repository_denied');
    }
  }

  async #removeSession(request) {
    const id = cookieValue(request, SESSION_COOKIE);
    if (id) await database(this.#env, 'DELETE FROM sessions WHERE session_hash = ?',
      [await sha256(id, this.#crypto)], 'run');
  }

  async #readSession(request) {
    const id = cookieValue(request, SESSION_COOKIE);
    if (!id) fail('Sign in with GitHub before importing.', 401, 'authentication_required');
    const hash = await sha256(id, this.#crypto);
    const row = await database(this.#env, 'SELECT payload, owner_id, expires_at FROM sessions WHERE session_hash = ?', [hash]);
    const now = this.#clock();
    if (!row) fail('Your session has ended. Sign in with GitHub again.', 401, 'authentication_required');
    if (Number(row.owner_id) !== OWNER_ID || !Number.isSafeInteger(row.expires_at) || row.expires_at <= now) {
      await this.#removeSession(request);
      fail('Your session has ended. Sign in with GitHub again.', 401, 'authentication_required');
    }
    let session;
    try { session = await open(row.payload, this.#env.APP_CREDENTIAL_KEY, `session:${hash}`, this.#crypto); }
    catch {
      await this.#removeSession(request);
      fail('Your session could not be verified. Sign in with GitHub again.', 401, 'authentication_required');
    }
    const config = await this.#config();
    if (!object(session) || Object.keys(session).length !== 7 ||
        Object.keys(session).some(name => !['token', 'csrfToken', 'user', 'createdAt', 'expiresAt', 'appId', 'installationId'].includes(name)) ||
        !userToken(session.token) || !/^[A-Za-z0-9_-]{43}$/.test(session.csrfToken ?? '') ||
        !object(session.user) || Object.keys(session.user).length !== 2 ||
        session.user.id !== OWNER_ID || session.user.login !== OWNER ||
        !Number.isSafeInteger(session.createdAt) || session.createdAt > now ||
        session.expiresAt !== row.expires_at || session.expiresAt > session.createdAt + SESSION_TTL ||
        !config?.installationId || session.appId !== config.appId || session.installationId !== config.installationId) {
      await this.#removeSession(request);
      fail('Your session could not be verified. Sign in with GitHub again.', 401, 'authentication_required');
    }
    return { token: session.token, user: { ...session.user }, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
  }

  async authenticate(request, { write = false } = {}) {
    this.#request(request);
    if (write) this.#writeOrigin(request);
    const session = await this.#readSession(request);
    if (write) {
      this.#csrf(request, session);
      try { session.user = await this.#identify(session.token); }
      catch (error) {
        if (error instanceof AuthError && ['authentication_required', 'account_denied', 'owner_required'].includes(error.code)) {
          await this.#removeSession(request);
        }
        throw error;
      }
    }
    return session;
  }

  handleSession(request) {
    return this.#endpoint(async () => {
      this.#request(request, 'GET');
      const config = await this.#config();
      try { return jsonResponse(publicSession(config, await this.#readSession(request))); }
      catch (error) {
        if (!(error instanceof AuthError) || error.status !== 401) throw error;
        return jsonResponse(publicSession(config), 200, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });
      }
    });
  }

  login(request) {
    return this.#endpoint(async () => {
      this.#request(request, 'GET');
      const config = await this.#config();
      if (!config?.installationId) fail('Complete the GitHub App installation before signing in.', 503, 'setup_required');
      const state = randomToken(this.#crypto);
      const verifier = randomToken(this.#crypto);
      const hash = await sha256(state, this.#crypto);
      const createdAt = this.#clock();
      const expiresAt = createdAt + STATE_TTL;
      const previous = cookieValue(request, OAUTH_COOKIE);
      if (previous) await database(this.#env, "DELETE FROM oauth_states WHERE state_hash = ? AND kind = 'oauth'",
        [await sha256(previous, this.#crypto)], 'run');
      await database(this.#env, 'DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE expires_at <= ? LIMIT 100)',
        [createdAt], 'run');
      await database(this.#env, 'DELETE FROM sessions WHERE session_hash IN (SELECT session_hash FROM sessions WHERE expires_at <= ? LIMIT 100)',
        [createdAt], 'run');
      const payload = await seal({ verifier, createdAt, expiresAt, appId: config.appId,
        clientId: config.clientId }, this.#env.APP_CREDENTIAL_KEY, `oauth-state:${hash}`, this.#crypto);
      await database(this.#env, "INSERT INTO oauth_states (state_hash, kind, payload, expires_at) VALUES (?, 'oauth', ?, ?)",
        [hash, payload, expiresAt], 'run');
      const challenge = base64url(new Uint8Array(await this.#crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${this.#origin}${OAUTH_CALLBACK_PATH}`,
        state, code_challenge: challenge, code_challenge_method: 'S256', login: OWNER, allow_signup: 'false' }).toString();
      return redirect(url.href, [cookie(OAUTH_COOKIE, state, expiresAt, createdAt)]);
    });
  }

  async callback(request) {
    let consumed = false;
    try {
      const url = this.#request(request, 'GET');
      const state = url.searchParams.get('state');
      const binding = cookieValue(request, OAUTH_COOKIE);
      if (url.href.length > 8192 || url.searchParams.getAll('state').length !== 1 ||
          !/^[A-Za-z0-9_-]{43}$/.test(state ?? '') || !equalToken(state, binding)) {
        fail('The GitHub sign-in state did not match this browser. Start sign-in again.', 403, 'invalid_state');
      }
      const hash = await sha256(state, this.#crypto);
      const now = this.#clock();
      const row = await database(this.#env,
        "DELETE FROM oauth_states WHERE state_hash = ? AND kind = 'oauth' AND expires_at > ? RETURNING payload, expires_at", [hash, now]);
      consumed = true;
      if (!row) fail('This GitHub sign-in link has expired or was already used. Start sign-in again.', 400, 'invalid_state');
      const config = await this.#config();
      if (!config?.installationId) fail('Complete the GitHub App installation before signing in.', 503, 'setup_required');
      const saved = await open(row.payload, this.#env.APP_CREDENTIAL_KEY, `oauth-state:${hash}`, this.#crypto);
      if (!object(saved) || Object.keys(saved).length !== 5 ||
          Object.keys(saved).some(name => !['verifier', 'createdAt', 'expiresAt', 'appId', 'clientId'].includes(name)) ||
          !/^[A-Za-z0-9_-]{43}$/.test(saved.verifier ?? '') || !Number.isSafeInteger(saved.createdAt) ||
          saved.createdAt > now || saved.expiresAt !== row.expires_at || saved.expiresAt > saved.createdAt + STATE_TTL ||
          saved.appId !== config.appId || saved.clientId !== config.clientId) {
        fail('The GitHub sign-in request could not be verified. Start sign-in again.', 400, 'invalid_state');
      }
      if (url.searchParams.has('error')) {
        return redirect(`${this.#origin}/studio?auth=cancelled#import`, [clearCookie(OAUTH_COOKIE)]);
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9_-]{1,256}$/.test(code ?? '')) {
        fail('GitHub did not return a valid sign-in code. Start sign-in again.', 400, 'invalid_code');
      }
      const issuedAt = this.#clock();
      const result = await this.#github('https://github.com/login/oauth/access_token', { body: {
        client_id: config.clientId, client_secret: config.clientSecret, code,
        redirect_uri: `${this.#origin}${OAUTH_CALLBACK_PATH}`, code_verifier: saved.verifier,
        repository_id: String(REPOSITORY_ID),
      } });
      if (!userToken(result.access_token) || result.token_type !== 'bearer' ||
          (result.expires_in !== undefined && (!Number.isSafeInteger(result.expires_in) || result.expires_in <= 30))) {
        fail('GitHub did not return a valid account session. Start sign-in again.', 502, 'invalid_github_response');
      }
      const expiresAt = issuedAt + Math.min(result.expires_in ?? SESSION_TTL / 1000, SESSION_TTL / 1000) * 1000 - 30000;
      const user = await this.#identify(result.access_token);
      await this.#checkRepository(result.access_token);
      if (expiresAt <= this.#clock()) fail('The GitHub session expired during sign-in. Start sign-in again.', 401, 'authentication_required');
      const id = randomToken(this.#crypto);
      const sessionHash = await sha256(id, this.#crypto);
      const session = { token: result.access_token, csrfToken: randomToken(this.#crypto), user,
        createdAt: issuedAt, expiresAt, appId: config.appId, installationId: config.installationId };
      const payload = await seal(session, this.#env.APP_CREDENTIAL_KEY, `session:${sessionHash}`, this.#crypto);
      await database(this.#env, 'INSERT INTO sessions (session_hash, payload, owner_id, expires_at) VALUES (?, ?, ?, ?)',
        [sessionHash, payload, OWNER_ID, expiresAt], 'run');
      await this.#removeSession(request);
      return redirect(`${this.#origin}${STUDIO_PATH}`, [clearCookie(OAUTH_COOKIE),
        cookie(SESSION_COOKIE, id, expiresAt, this.#clock())]);
    } catch (error) {
      const response = authErrorResponse(error);
      if (consumed) response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
      return response;
    }
  }

  logout(request) {
    return this.#endpoint(async () => {
      this.#writeOrigin(request);
      let session;
      try { session = await this.#readSession(request); }
      catch (error) { if (!(error instanceof AuthError) || error.status !== 401) throw error; }
      if (session) this.#csrf(request, session);
      await this.#removeSession(request);
      const binding = cookieValue(request, OAUTH_COOKIE);
      if (binding) await database(this.#env, "DELETE FROM oauth_states WHERE state_hash = ? AND kind = 'oauth'",
        [await sha256(binding, this.#crypto)], 'run');
      const response = jsonResponse({ authorized: false });
      response.headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
      response.headers.append('Set-Cookie', clearCookie(OAUTH_COOKIE));
      return response;
    });
  }
}
