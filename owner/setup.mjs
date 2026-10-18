/** One-time, fixed-owner GitHub App registration. This module is server-only. */
import { AppGitHubClient, GitHubError, validatePrivateKey, OWNER, OWNER_ID, REPOSITORY_ID,
  API_VERSION } from './github-app.mjs';
import { seal, open, sha256, randomToken, validateAppConfig,
  OAUTH_CALLBACK_PATH } from './auth.mjs';

export const SETUP_PATH = '/api/owner/setup';
export const SETUP_CALLBACK_PATH = `${SETUP_PATH}/callback`;
export const SETUP_INSTALL_PATH = `${SETUP_PATH}/install`;
export const SETUP_COOKIE = '__Host-seo_yuna_setup';
export const INSTALL_COOKIE = '__Host-seo_yuna_setup_install';
export const SETUP_TTL = 10 * 60 * 1000;
const STUDIO_PATH = '/studio#import';
const PUBLIC_URL = `https://${OWNER}.github.io/seo-yuna/`;
const MAX_CONVERSION_BYTES = 64 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const REGISTRATION_RECOVERY = 'The app may already exist on GitHub. Return to the owner studio before starting another registration.';
const CONVERSION_PHASES = new Set(['http', 'transport', 'timeout', 'key', 'config']);
const ERROR_CATEGORIES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'NetworkError',
  'DataError', 'NotSupportedError', 'OperationError', 'InvalidAccessError', 'SyntaxError', 'GitHubError', 'AuthError']);

export class SetupError extends Error {
  constructor(message, status = 503, code = 'setup_unavailable') {
    super(message);
    this.name = 'SetupError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status = 503, code = 'setup_unavailable') {
  throw new SetupError(message, status, code);
}

/** No exception messages, callback URLs, conversion codes, or response bodies enter logs. */
function conversionDiagnostic(phase, { status, requestId, error } = {}) {
  if (!CONVERSION_PHASES.has(phase)) return;
  const detail = { event: 'seo_yuna_setup_conversion_failure', phase };
  if (phase === 'http') {
    if (Number.isInteger(status) && status >= 100 && status <= 599) detail.status = status;
    if (typeof requestId === 'string' && requestId.length <= 100 &&
        /^[a-f0-9]{1,16}(?::[a-f0-9]{1,16}){1,7}$/i.test(requestId)) detail.githubRequestId = requestId;
  } else {
    let name;
    try { name = error?.name; } catch { /* Unknown objects never contribute log content. */ }
    detail.category = ERROR_CATEGORIES.has(name) ? name : 'UnknownError';
  }
  try { console.warn(JSON.stringify(detail)); } catch { /* Logging must not change setup behavior. */ }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function positiveId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function originOf(env) {
  try {
    const url = new URL(env.APP_ORIGIN);
    if (url.protocol === 'https:' && url.origin === env.APP_ORIGIN && !url.username && !url.password) {
      return url.origin;
    }
  } catch { /* Configuration errors never expose environment values. */ }
  fail('The server’s GitHub setup address is unavailable.');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function privateHeaders(extra) {
  const headers = new Headers(extra);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Vary', 'Cookie');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
  return headers;
}

function htmlResponse(title, body, status = 200, extra) {
  const headers = privateHeaders(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/style.css"><title>${escapeHtml(title)} · Seo Yuna</title></head><body class="owner-auth-page"><main class="owner-auth-card"><p class="owner-auth-brand">SEO YUNA · OWNER STUDIO</p><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`, { status, headers });
}

function redirect(location, extra) {
  const headers = privateHeaders(extra);
  headers.set('Location', location);
  return new Response(null, { status: 303, headers });
}

function cookie(name, token, maxAge = SETUP_TTL / 1000) {
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
  const matches = (request.headers.get('Cookie') || '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN.test(value) ? value : null;
}

function sameToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !TOKEN.test(left) || !TOKEN.test(right)) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

function singleQuery(url, name) {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function statePurpose(kind, hash) {
  return `${kind === 'setup' ? 'setup-state' : 'setup-install'}:${hash}`;
}

/** The manifest requests no webhook deliveries and only the two required repository permissions. */
export function createManifest(appOrigin) {
  const origin = originOf({ APP_ORIGIN: appOrigin });
  return {
    name: 'SeoYunaBudhiHalim',
    url: PUBLIC_URL,
    public: false,
    redirect_url: `${origin}${SETUP_CALLBACK_PATH}`,
    callback_urls: [`${origin}${OAUTH_CALLBACK_PATH}`],
    setup_url: `${origin}${SETUP_INSTALL_PATH}`,
    request_oauth_on_install: false,
    setup_on_update: false,
    hook_attributes: { url: `${origin}/api/owner/webhook`, active: false },
    default_permissions: { contents: 'write', actions: 'write' },
    default_events: [],
  };
}

function convertedConfig(value) {
  if (!object(value) || !object(value.owner) || value.owner.id !== OWNER_ID ||
      typeof value.owner.login !== 'string' || value.owner.login.toLowerCase() !== OWNER ||
      value.owner.type !== 'User') {
    fail('Only the budhi-halim GitHub account can connect this website.', 403, 'wrong_owner');
  }
  // The documented conversion response omits visibility. The outgoing manifest fixes it to false;
  // reject any explicit incompatible value if GitHub adds this field to its response.
  if ((Object.hasOwn(value, 'public') && value.public !== false) ||
      !object(value.permissions) || value.permissions.contents !== 'write' || value.permissions.actions !== 'write' ||
      Object.entries(value.permissions).some(([key, permission]) =>
        key !== 'contents' && key !== 'actions' && !(key === 'metadata' && permission === 'read')) ||
      (value.events !== undefined && (!Array.isArray(value.events) || value.events.length !== 0))) {
    fail('GitHub returned app settings that do not match this website’s private connection.', 403, 'invalid_app_settings');
  }
  if (!positiveId(value.id) || typeof value.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value.slug) ||
      typeof value.client_id !== 'string' || !/^[A-Za-z0-9_.-]{16,160}$/.test(value.client_id) ||
      typeof value.client_secret !== 'string' || !/^[A-Za-z0-9_.-]{32,512}$/.test(value.client_secret) ||
      typeof value.pem !== 'string' || value.pem.length < 512 || value.pem.length > 32768 ||
      !/^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----[\r\n \t]+[A-Za-z0-9+/=\r\n \t]+[\r\n \t]+-----END \1-----[\r\n \t]*$/.test(value.pem) ||
      (value.html_url !== undefined && value.html_url !== `https://github.com/apps/${value.slug}`) ||
      (value.external_url !== undefined && value.external_url !== PUBLIC_URL)) {
    fail(`GitHub returned an incomplete app connection. ${REGISTRATION_RECOVERY}`, 502, 'invalid_app_response');
  }
  return validateAppConfig({ appId: value.id, clientId: value.client_id, clientSecret: value.client_secret,
    privateKey: value.pem.trim(), slug: value.slug, installationId: null });
}

async function readConversion(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CONVERSION_BYTES) {
    try { await response.body?.cancel(); } catch { /* Do not expose upstream errors. */ }
    fail('GitHub returned an invalid app response.', 502, 'invalid_app_response');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('GitHub returned an invalid app response.', 502, 'invalid_app_response');
  const chunks = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_CONVERSION_BYTES) throw new Error('Size limit');
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  } catch {
    try { await reader.cancel(); } catch { /* Do not expose upstream errors. */ }
    fail('GitHub returned an invalid app response.', 502, 'invalid_app_response');
  } finally {
    reader.releaseLock();
  }
}

export function setupErrorResponse(error) {
  const known = error instanceof SetupError;
  const code = known ? error.code : 'setup_unavailable';
  const message = known ? error.message : 'GitHub setup is temporarily unavailable. Please try again from the owner studio.';
  const recovery = code === 'setup_exists' || code === 'invalid_install_state' || code === 'installation_unverified';
  return htmlResponse('GitHub connection', `<p data-error-code="${escapeHtml(code)}">${escapeHtml(message)}</p>${recovery ? `<form action="${SETUP_INSTALL_PATH}" method="post"><button type="submit">Continue existing app setup</button></form>` : ''}<p><a href="${STUDIO_PATH}">Return to owner studio</a></p>`, known ? error.status : 503);
}

export class SetupService {
  #env;
  #fetch;
  #crypto;
  #now;
  #githubFactory;
  #timeout;

  constructor(env, { fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto, now = Date.now,
    githubClientFactory = (config, options) => new AppGitHubClient(config, options), timeoutMs = 35000 } = {}) {
    this.#env = env;
    this.#fetch = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetchImpl;
    this.#crypto = cryptoImpl;
    this.#now = now;
    this.#githubFactory = githubClientFactory;
    this.#timeout = timeoutMs;
  }

  #clock() {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - SETUP_TTL) {
      fail('The server clock is unavailable.');
    }
    return now;
  }

  async #db(sql, bindings = [], method = 'first') {
    try {
      const result = await this.#env.DB.prepare(sql).bind(...bindings)[method]();
      if (result?.success === false) throw new Error('Database operation failed');
      return result;
    } catch {
      fail('GitHub setup storage is temporarily unavailable. Please try again.');
    }
  }

  async #row() {
    return this.#db("SELECT payload FROM app_config WHERE id = 'github_app'");
  }

  async #config(row) {
    if (!row) fail('Register the private GitHub App before continuing installation.', 409, 'setup_required');
    return validateAppConfig(await open(row.payload, this.#env.APP_CREDENTIAL_KEY, 'app-config', this.#crypto));
  }

  async #newState(request, kind, origin, appId = null) {
    const now = this.#clock();
    const token = randomToken(this.#crypto);
    const hash = await sha256(token, this.#crypto);
    const expiresAt = now + SETUP_TTL;
    const state = { version: 1, origin, ownerId: OWNER_ID, repositoryId: REPOSITORY_ID, appId,
      createdAt: now, expiresAt };
    const payload = await seal(state, this.#env.APP_CREDENTIAL_KEY, statePurpose(kind, hash), this.#crypto);
    await this.#db('DELETE FROM oauth_states WHERE state_hash IN (SELECT state_hash FROM oauth_states WHERE kind = ? AND expires_at <= ? LIMIT 100)',
      [kind, now], 'run');
    const previous = readCookie(request, kind === 'setup' ? SETUP_COOKIE : INSTALL_COOKIE);
    if (previous) {
      await this.#db('DELETE FROM oauth_states WHERE state_hash = ? AND kind = ?',
        [await sha256(previous, this.#crypto), kind], 'run');
    }
    await this.#db('INSERT INTO oauth_states (state_hash, kind, payload, expires_at) VALUES (?, ?, ?, ?)',
      [hash, kind, payload, expiresAt], 'run');
    return token;
  }

  async #consumeState(request, url, kind, origin) {
    const code = kind === 'setup' ? 'invalid_setup_state' : 'invalid_install_state';
    const name = kind === 'setup' ? SETUP_COOKIE : INSTALL_COOKIE;
    const token = singleQuery(url, 'state');
    if (!sameToken(token, readCookie(request, name))) {
      fail('This GitHub setup link is invalid or has expired. Return to the owner studio to continue.', 400, code);
    }
    const hash = await sha256(token, this.#crypto);
    const row = await this.#db('DELETE FROM oauth_states WHERE state_hash = ? AND kind = ? AND expires_at > ? RETURNING payload, expires_at',
      [hash, kind, this.#clock()]);
    if (!row) fail('This GitHub setup link has expired or has already been used. Return to the owner studio to continue.', 400, code);
    const state = await open(row.payload, this.#env.APP_CREDENTIAL_KEY, statePurpose(kind, hash), this.#crypto);
    const now = this.#clock();
    if (!object(state) || Object.keys(state).length !== 7 || state.version !== 1 ||
        state.origin !== origin || state.ownerId !== OWNER_ID || state.repositoryId !== REPOSITORY_ID ||
        (kind === 'setup' ? state.appId !== null : !positiveId(state.appId)) ||
        !Number.isSafeInteger(state.createdAt) || state.createdAt < 0 || state.createdAt > now ||
        !Number.isSafeInteger(state.expiresAt) || state.expiresAt !== state.createdAt + SETUP_TTL ||
        state.expiresAt <= now || row.expires_at !== state.expiresAt) {
      fail('This GitHub setup link could not be verified. Return to the owner studio to continue.', 400, code);
    }
    return state;
  }

  async #convert(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(code)) {
      fail(`GitHub did not return a valid app registration. ${REGISTRATION_RECOVERY}`, 400, 'invalid_conversion');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeout);
    let phase = 'transport';
    try {
      const response = await this.#fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST', headers: { Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'seo-yuna-owner' },
        // Workerd supports manual redirects; reject every non-201 response below.
        cache: 'no-store', redirect: 'manual', signal: controller.signal,
      });
      phase = 'config';
      if (response.status !== 201) {
        conversionDiagnostic('http', { status: response.status, requestId: response.headers.get('x-github-request-id') });
        try { await response.body?.cancel(); } catch { /* Never return a conversion response body. */ }
        fail(`GitHub did not confirm the app connection. ${REGISTRATION_RECOVERY}`, 502, 'conversion_http_failed');
      }
      const config = convertedConfig(await readConversion(response));
      phase = 'key';
      await validatePrivateKey(config.privateKey, { cryptoImpl: this.#crypto });
      return config;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      if (phase === 'key') {
        conversionDiagnostic('key', { error });
        fail('GitHub returned the app connection, but this server could not verify its private key. Return to the owner studio; do not create another app yet.',
          502, 'conversion_key_invalid');
      }
      if (phase === 'transport') {
        const timedOut = controller.signal.aborted;
        conversionDiagnostic(timedOut ? 'timeout' : 'transport', { error });
        fail(`${timedOut ? 'The connection to GitHub timed out.' : 'This server could not complete the connection to GitHub.'} ${REGISTRATION_RECOVERY}`,
          502, timedOut ? 'conversion_timeout' : 'conversion_transport_failed');
      }
      conversionDiagnostic('config', { error });
      fail(`The app connection could not be verified by this server. ${REGISTRATION_RECOVERY}`, 502, 'conversion_config_invalid');
    } finally {
      clearTimeout(timer);
    }
  }

  async #installation(config) {
    return this.#githubFactory(config, { fetchImpl: this.#fetch, cryptoImpl: this.#crypto,
      now: this.#now, timeoutMs: this.#timeout }).verifyInstallation();
  }

  async #saveInstallation(row, config, metadata) {
    const updated = validateAppConfig({ ...config, installationId: metadata?.installationId,
      installationMetadata: metadata });
    if (!updated.installationId || !updated.installationMetadata) {
      fail('GitHub could not verify the seo-yuna installation.', 403, 'installation_unverified');
    }
    const payload = await seal(updated, this.#env.APP_CREDENTIAL_KEY, 'app-config', this.#crypto);
    const result = await this.#db("UPDATE app_config SET payload = ?, updated_at = ? WHERE id = 'github_app' AND payload = ?",
      [payload, this.#clock(), row.payload], 'run');
    if (result?.meta?.changes !== 1) {
      const current = await this.#config(await this.#row());
      if (current.appId !== config.appId || current.clientId !== config.clientId ||
          current.installationId !== updated.installationId || !current.installationMetadata) {
        fail('The app connection changed while GitHub was being checked. Continue from the owner studio.', 409, 'setup_changed');
      }
    }
  }

  async #start(request, origin) {
    if (await this.#row()) fail('This website already has a GitHub App. Continue its installation or sign in from the owner studio.', 409, 'setup_exists');
    const token = await this.#newState(request, 'setup', origin);
    // A failed handshake may leave an app name registered on GitHub. This public
    // suffix uses separate randomness and never reveals any portion of the state.
    const suffix = Array.from(this.#crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('');
    const parameters = createManifest(origin);
    parameters.name = `${parameters.name}-${suffix}`;
    const manifest = escapeHtml(JSON.stringify(parameters));
    const body = `<p>Continue with the <strong>budhi-halim</strong> GitHub account to register this website’s private connection.</p><p>GitHub will then ask you to install it. Choose <strong>Only select repositories</strong> and select <strong>seo-yuna</strong>.</p><form action="https://github.com/settings/apps/new?state=${token}" method="post"><input type="hidden" name="manifest" value="${manifest}"><button type="submit">Continue on GitHub</button></form><p><a href="${STUDIO_PATH}">Return to owner studio</a></p>`;
    return htmlResponse('Connect GitHub', body, 200, { 'Set-Cookie': cookie(SETUP_COOKIE, token) });
  }

  async #callback(request, url, origin) {
    await this.#consumeState(request, url, 'setup', origin);
    if (await this.#row()) fail('This website already has a GitHub App. Continue its installation or sign in from the owner studio.', 409, 'setup_exists');
    const config = await this.#convert(singleQuery(url, 'code'));
    const payload = await seal(config, this.#env.APP_CREDENTIAL_KEY, 'app-config', this.#crypto);
    const result = await this.#db("INSERT OR IGNORE INTO app_config (id, payload, updated_at) VALUES ('github_app', ?, ?)",
      [payload, this.#clock()], 'run');
    if (result?.meta?.changes !== 1) fail('This website already has a GitHub App. Continue its installation or sign in from the owner studio.', 409, 'setup_exists');
    const token = await this.#newState(request, 'setup-install', origin, config.appId);
    const response = redirect(`https://github.com/apps/${config.slug}/installations/new?state=${token}`);
    response.headers.append('Set-Cookie', cookie(SETUP_COOKIE, '', 0));
    response.headers.append('Set-Cookie', cookie(INSTALL_COOKIE, token));
    return response;
  }

  async #install(request, url, origin) {
    const state = await this.#consumeState(request, url, 'setup-install', origin);
    const installation = singleQuery(url, 'installation_id');
    const installationId = typeof installation === 'string' && /^[1-9][0-9]{0,15}$/.test(installation) ? Number(installation) : null;
    const action = singleQuery(url, 'setup_action');
    if (!positiveId(installationId) || (action !== 'install' && action !== 'update')) {
      fail('GitHub did not complete the seo-yuna installation. Continue setup from the owner studio.', 400, 'installation_unverified');
    }
    const row = await this.#row();
    const config = await this.#config(row);
    if (state.appId !== config.appId || (config.installationId !== null && config.installationId !== installationId)) {
      fail('The GitHub installation does not match this website’s app.', 403, 'installation_unverified');
    }
    let metadata;
    try { metadata = await this.#installation({ ...config, installationId }); }
    catch { fail('GitHub could not verify the private app’s access to seo-yuna. Choose only seo-yuna when continuing setup.', 403, 'installation_unverified'); }
    await this.#saveInstallation(row, config, metadata);
    return redirect(STUDIO_PATH, { 'Set-Cookie': cookie(INSTALL_COOKIE, '', 0) });
  }

  async #resume(request, origin) {
    const row = await this.#row();
    const config = await this.#config(row);
    // An installation may have succeeded on GitHub even when its browser callback was lost.
    let metadata;
    try { metadata = await this.#installation(config); }
    catch (error) {
      if (!(error instanceof GitHubError) || (error.status !== 403 && error.status !== 404)) {
        fail('GitHub could not check the existing app installation. Please try again.', 502, 'installation_check_failed');
      }
    }
    if (metadata) {
      await this.#saveInstallation(row, config, metadata);
      return redirect(STUDIO_PATH, { 'Set-Cookie': cookie(INSTALL_COOKIE, '', 0) });
    }
    const token = await this.#newState(request, 'setup-install', origin, config.appId);
    return redirect(`https://github.com/apps/${config.slug}/installations/new?state=${token}`,
      { 'Set-Cookie': cookie(INSTALL_COOKIE, token) });
  }

  /** Unrelated routes return null so the parent router can dispatch them normally. */
  async handle(request) {
    let url;
    try { url = new URL(request.url); } catch { return setupErrorResponse(new SetupError('Invalid setup request.', 400, 'invalid_request')); }
    if (![SETUP_PATH, SETUP_CALLBACK_PATH, SETUP_INSTALL_PATH].includes(url.pathname)) return null;
    try {
      const origin = originOf(this.#env);
      if (url.origin !== origin) fail('This GitHub setup request has the wrong website address.', 403, 'invalid_origin');
      if (!this.#crypto?.subtle || typeof this.#crypto.getRandomValues !== 'function' ||
          typeof this.#fetch !== 'function' || typeof this.#now !== 'function' || typeof this.#githubFactory !== 'function' ||
          !Number.isInteger(this.#timeout) || this.#timeout < 1 || this.#timeout > 90000) {
        fail('The server could not initialize GitHub setup.');
      }
      if (request.method === 'POST' && [SETUP_PATH, SETUP_INSTALL_PATH].includes(url.pathname)) {
        if (request.headers.get('Origin') !== origin) fail('Open GitHub setup directly from the owner studio.', 403, 'invalid_origin');
        return url.pathname === SETUP_PATH ? await this.#start(request, origin) : await this.#resume(request, origin);
      }
      if (request.method === 'GET' && url.pathname === SETUP_CALLBACK_PATH) return await this.#callback(request, url, origin);
      if (request.method === 'GET' && url.pathname === SETUP_INSTALL_PATH) return await this.#install(request, url, origin);
      fail('This GitHub setup route does not support that request method.', 405, 'invalid_method');
    } catch (error) {
      return setupErrorResponse(error);
    }
  }
}

export async function handleSetup(request, options = {}) {
  return new SetupService(options.env, options).handle(request);
}
