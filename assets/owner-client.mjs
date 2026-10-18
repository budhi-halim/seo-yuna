import { GitHubClient, OWNER } from './github.mjs';
import { MAX_IMPORT_BYTES } from './catalog.mjs';

// Set during deployment. Never derive the owner endpoint from storage or input.
export const OWNER_STUDIO_URL = 'https://seo-yuna-owner.halimbudhiarto.chatgpt.site/studio';

const API = '/api/owner';
const EMPTY_SESSION = Object.freeze({ authorized: false, configured: false, login: null, expiresAt: null, installationReady: false });
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function trustedStudioURL(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/studio' || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

export function isOwnerStudioContext(locationValue = globalThis.location, ownerStudioUrl = OWNER_STUDIO_URL) {
  const owner = trustedStudioURL(ownerStudioUrl);
  if (!owner || !locationValue) return false;
  try {
    const current = new URL(typeof locationValue === 'string' ? locationValue : locationValue.href);
    return current.origin === owner.origin && current.pathname === owner.pathname && !current.username && !current.password;
  } catch { return false; }
}

export class OwnerAccessError extends Error {
  constructor(message, status = 0, uncertain = false) {
    super(message);
    this.name = 'OwnerAccessError';
    this.status = status;
    this.uncertain = uncertain;
  }
}

function statusMessage(status, dispatch = false) {
  if (status === 401) return 'Sign in with GitHub again to continue in the owner studio.';
  if (status === 403) return 'The signed-in GitHub account is not authorized to change this collection.';
  if (status === 404) return 'The requested owner service or workflow could not be found.';
  if (status === 409) return 'The submission state changed. Check Activity before trying again.';
  if (status === 413) return 'This import exceeds 5 MiB. Split the batch and try again.';
  if (status === 422) return 'The importer rejected this batch. Validate the JSON and check its submission details.';
  if (status === 429) return 'The service is limiting requests. Wait before trying again.';
  if (status >= 500) return dispatch
    ? 'The importer reported a server error. Acceptance is unconfirmed; check Activity before retrying.'
    : 'The owner service is unavailable. Check the connection and try again.';
  return `The owner service could not complete this request (HTTP ${status}).`;
}

function expiryMillis(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  return Date.parse(value);
}

function normalizedRunId(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9]\d*$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** GitHub credentials remain on the server; only a short-lived CSRF value lives here. */
export class OwnerClient {
  #fetch;
  #public;
  #studio;
  #location;
  #initialOwnerContext;
  #now;
  #session = EMPTY_SESSION;
  #csrf = '';
  #expires = 0;
  #checked = false;
  #generation = 0;

  constructor({ fetchImpl = globalThis.fetch, location = globalThis.location, ownerStudioUrl = OWNER_STUDIO_URL, now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('The owner client requires a network and clock implementation.');
    // Native Window.fetch requires the global receiver, not this client instance.
    this.#fetch = fetchImpl.bind(globalThis);
    this.#public = new GitHubClient('', fetchImpl);
    this.#studio = trustedStudioURL(ownerStudioUrl);
    this.#location = location;
    this.#initialOwnerContext = isOwnerStudioContext(location, ownerStudioUrl);
    this.#now = now;
  }

  get ownerStudioUrl() { return this.#studio?.href ?? ''; }
  get ownerContext() { return this.#initialOwnerContext && isOwnerStudioContext(this.#location, this.ownerStudioUrl); }
  get sessionChecked() { return this.#checked; }
  get configured() { return this.ownerContext && this.#session.configured; }
  get installationReady() { return this.ownerContext && this.#session.installationReady; }
  get authorized() { return this.ownerContext && this.#session.authorized && this.#expires > this.#now() && !!this.#csrf; }
  get connected() { return this.authorized && this.configured && this.installationReady; }
  get login() { return this.authorized ? OWNER : null; }
  get expiresAt() { return this.authorized ? this.#session.expiresAt : null; }
  get loginUrl() { return this.ownerContext && this.configured && this.installationReady ? new URL(`${API}/auth/login`, this.#studio).href : ''; }
  get setupUrl() { return this.ownerContext ? new URL(this.configured ? `${API}/setup/install` : `${API}/setup`, this.#studio).href : ''; }

  disconnect() {
    this.#generation += 1;
    this.#csrf = '';
    this.#expires = 0;
    this.#session = { ...this.#session, authorized: false, login: null, expiresAt: null };
  }

  #requireOwner() {
    if (!this.ownerContext) throw new OwnerAccessError('Open the configured owner studio to submit JSON.', 403);
  }

  #requireSession(requireInstallation = true) {
    this.#requireOwner();
    if (!this.authorized) throw new OwnerAccessError('Sign in with GitHub before submitting JSON.', 401);
    if (requireInstallation && (!this.configured || !this.installationReady)) {
      throw new OwnerAccessError('Complete the GitHub connection in the owner studio before submitting.', 403);
    }
  }

  async #request(path, { method = 'GET', body, raw = false, allowSignedOut = false, timeout = 35000 } = {}) {
    this.#requireOwner();
    const url = new URL(path, this.#studio);
    const readAllowed = method === 'GET' && (
      [`${API}/session`, `${API}/catalog`, `${API}/runs`].includes(url.pathname) ||
      /^\/api\/owner\/runs\/[1-9]\d*(?:\/jobs)?$/.test(url.pathname)
    );
    const writeAllowed = method === 'POST' && [`${API}/stage`, `${API}/dispatch`, `${API}/auth/logout`].includes(url.pathname);
    if (url.origin !== this.#studio.origin || (!readAllowed && !writeAllowed) || url.username || url.password || url.hash) {
      throw new OwnerAccessError('The owner request destination is not trusted.', 403);
    }
    if (writeAllowed) this.#requireSession(url.pathname !== `${API}/auth/logout`);
    const dispatch = url.pathname === `${API}/dispatch`;
    const headers = { Accept: 'application/json' };
    if (writeAllowed) {
      headers['X-CSRF-Token'] = this.#csrf;
      headers['Content-Type'] = 'application/json';
    }
    const generation = this.#generation;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.#fetch(url.href, {
        method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      });
      // Native fetch enforces redirect:error; checking the final URL also protects adapters.
      if (response.redirected || (response.url && new URL(response.url).href !== url.href)) {
        throw new OwnerAccessError('The owner service returned an untrusted redirect.', 0, dispatch);
      }
      if (response.status === 401 && allowSignedOut) {
        let value = {};
        try { value = await response.json(); } catch { /* An empty 401 is a normal signed-out response. */ }
        return { signedOut: true, value };
      }
      if (!response.ok) {
        let uncertain = dispatch && response.status >= 500;
        if (dispatch) {
          try {
            const failure = await response.json();
            // The server can distinguish a definite failure from an interrupted dispatch.
            if (typeof failure?.uncertain === 'boolean') uncertain = failure.uncertain;
          } catch { /* HTTP status remains the conservative fallback. */ }
        }
        if ([401, 403].includes(response.status) && generation === this.#generation) this.disconnect();
        throw new OwnerAccessError(statusMessage(response.status, dispatch && uncertain), response.status, uncertain);
      }
      if (response.status === 204) return null;
      return raw ? await response.text() : await response.json();
    } catch (error) {
      if (error instanceof OwnerAccessError) throw error;
      // Never expose response bodies, request objects, or upstream exception text.
      throw new OwnerAccessError(dispatch
        ? 'The connection to the secure importer was interrupted. Check Activity before retrying the submission.'
        : 'The connection to the secure importer was interrupted. Please try again.', 0, dispatch);
    } finally { clearTimeout(timer); }
  }

  async verifyConnection() {
    const generation = ++this.#generation;
    this.#csrf = '';
    this.#expires = 0;
    this.#session = EMPTY_SESSION;
    this.#checked = false;
    if (!this.ownerContext) return { ...EMPTY_SESSION };
    try {
      const result = await this.#request(`${API}/session`, { allowSignedOut: true });
      if (generation !== this.#generation) return { ...EMPTY_SESSION };
      const signedOut = result?.signedOut === true;
      let value = signedOut ? result.value : result;
      if (signedOut && (!value || typeof value !== 'object' || Array.isArray(value))) value = {};
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnerAccessError('The owner account response could not be verified.', 0);
      if (signedOut && value.authorized === true) throw new OwnerAccessError('The owner account response could not be verified.', 0);
      if (!signedOut && typeof value.authorized !== 'boolean') throw new OwnerAccessError('The owner account response could not be verified.', 0);
      if (value.configured !== undefined && typeof value.configured !== 'boolean') throw new OwnerAccessError('The owner account response could not be verified.', 0);
      if (value.installationReady !== undefined && typeof value.installationReady !== 'boolean') throw new OwnerAccessError('The owner account response could not be verified.', 0);
      const session = { ...EMPTY_SESSION, configured: value.configured === true, installationReady: value.installationReady === true };
      if (!signedOut && value.authorized === true) {
        const expires = expiryMillis(value.expiresAt);
        if (typeof value.configured !== 'boolean' || typeof value.installationReady !== 'boolean' ||
            typeof value.login !== 'string' || value.login.toLowerCase() !== OWNER ||
            typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_+/=.~-]{32,512}$/.test(value.csrfToken) ||
            !Number.isFinite(expires) || expires <= this.#now()) {
          throw new OwnerAccessError('The owner account response could not be verified. Sign in with GitHub again.', 0);
        }
        this.#csrf = value.csrfToken;
        this.#expires = expires;
        Object.assign(session, { authorized: true, login: OWNER, expiresAt: new Date(expires).toISOString() });
      }
      this.#session = session;
      this.#checked = true;
      return { ...session };
    } catch (error) {
      if (generation === this.#generation) {
        this.#csrf = ''; this.#expires = 0; this.#session = EMPTY_SESSION; this.#checked = false;
      }
      throw error;
    }
  }

  async readCanonical() {
    this.#requireSession();
    return this.#request(`${API}/catalog`, { raw: true });
  }

  async stageBlob(source) {
    this.#requireSession();
    if (typeof source !== 'string' || !source.trim() || new TextEncoder().encode(source).byteLength > MAX_IMPORT_BYTES) {
      throw new OwnerAccessError('Provide a validated JSON import of up to 5 MiB.', 413);
    }
    const result = await this.#request(`${API}/stage`, { method: 'POST', body: source, timeout: 90000 });
    if (!SHA1.test(result?.sha ?? '')) throw new OwnerAccessError('The upload receipt could not be verified. The batch was not submitted.', 0);
    return result.sha;
  }

  async dispatch(receipt) {
    this.#requireSession();
    if (!receipt || typeof receipt.blobSha !== 'string' || !SHA1.test(receipt.blobSha) ||
        typeof receipt.digest !== 'string' || !SHA256.test(receipt.digest) ||
        typeof receipt.requestId !== 'string' || !REQUEST_ID.test(receipt.requestId)) {
      throw new OwnerAccessError('The upload receipt is incomplete. Validate and upload the batch again.', 422);
    }
    const result = await this.#request(`${API}/dispatch`, { method: 'POST', body: JSON.stringify({
      requestId: receipt.requestId, blobSha: receipt.blobSha, digest: receipt.digest,
    }) });
    if (result?.accepted !== true) {
      throw new OwnerAccessError('The importer did not confirm acceptance. Check Activity before retrying this submission.', 0, true);
    }
    return { accepted: true, runId: normalizedRunId(result.runId) };
  }

  async #publicRead(operation) {
    try { return await operation(); }
    catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 0;
      const message = [403, 429].includes(status)
        ? 'GitHub is limiting public status requests. Wait before checking again, or open the owner studio.'
        : 'GitHub run details could not be loaded. Use the GitHub Actions link to check this submission.';
      throw new OwnerAccessError(message, status);
    }
  }

  async readRun(id) {
    const runId = normalizedRunId(id);
    if (!runId) throw new OwnerAccessError('Invalid workflow run ID.', 422);
    return this.connected ? this.#request(`${API}/runs/${runId}`) : this.#publicRead(() => this.#public.readRun(runId));
  }

  async readJobs(id) {
    const runId = normalizedRunId(id);
    if (!runId) throw new OwnerAccessError('Invalid workflow run ID.', 422);
    return this.connected ? this.#request(`${API}/runs/${runId}/jobs`) : this.#publicRead(() => this.#public.readJobs(runId));
  }

  async findRun(requestId, createdAt) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new OwnerAccessError('Invalid submission reference.', 422);
    if (typeof createdAt !== 'string' || !Number.isFinite(expiryMillis(createdAt))) throw new OwnerAccessError('Invalid submission date.', 422);
    if (!this.connected) return this.#publicRead(() => this.#public.findRun(requestId, createdAt));
    const params = new URLSearchParams({ request_id: requestId, created_at: createdAt });
    const run = await this.#request(`${API}/runs?${params}`);
    if (run === null) return null;
    if (!run || typeof run !== 'object' || !normalizedRunId(run.id) || run.display_title !== `Import ${requestId}`) {
      throw new OwnerAccessError('The matching workflow run could not be verified. Check Activity again before retrying.', 0);
    }
    return run;
  }

  async logout() {
    this.#requireSession(false);
    await this.#request(`${API}/auth/logout`, { method: 'POST', body: '{}' });
    this.disconnect();
  }
}
