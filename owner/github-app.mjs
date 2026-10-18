/** Server-only GitHub access. Browser identity and credential storage belong to the caller. */
export const OWNER = 'budhi-halim';
export const OWNER_ID = 121861881;
export const REPO = 'seo-yuna';
export const REPOSITORY = `${OWNER}/${REPO}`;
export const REPOSITORY_ID = 1423899802;
export const BRANCH = 'master';
export const WORKFLOW = 'studio.yml';
export const API_VERSION = '2026-03-10';

const API_ROOT = 'https://api.github.com';
const REPO_PATH = `/repos/${REPOSITORY}`;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export class GitHubError extends Error {
  constructor(message, status = 0, { uncertain = status === 0 || status >= 500 } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.uncertain = uncertain;
  }
}

function reject(message, status = 400) {
  throw new GitHubError(message, status, { uncertain: false });
}

function positiveId(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') ||
      !/^[1-9][0-9]{0,15}$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,99})$/.test(value);
}

function hasWritePermissions(value, exact = false) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    value.contents === 'write' && value.actions === 'write' &&
    (!exact || Object.entries(value).every(([key, permission]) =>
      key === 'contents' || key === 'actions' || (key === 'metadata' && permission === 'read')));
}

function isOwner(account) {
  return positiveId(account?.id) === OWNER_ID &&
    typeof account?.login === 'string' && account.login.toLowerCase() === OWNER;
}

function isRepository(repository) {
  return positiveId(repository?.id) === REPOSITORY_ID && isOwner(repository.owner) &&
    typeof repository.full_name === 'string' && repository.full_name.toLowerCase() === REPOSITORY;
}

function base64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64url(bytes) {
  return base64(bytes).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function der(tag, content) {
  const length = [];
  for (let remaining = content.length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    length.unshift(remaining % 256);
  }
  const prefix = content.length < 128 ? [tag, content.length] : [tag, 0x80 | length.length, ...length];
  const result = new Uint8Array(prefix.length + content.length);
  result.set(prefix);
  result.set(content, prefix.length);
  return result;
}

/** WebCrypto accepts PKCS8; GitHub normally supplies a PKCS1 RSA PEM. */
function decodePrivateKey(pem) {
  const match = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s+([A-Za-z0-9+/=\r\n\t ]+?)\s+-----END \1-----$/.exec(pem);
  if (!match) reject('The stored GitHub App private key is not a supported RSA PEM. Reconnect the app.', 503);
  const encoded = match[2].replace(/\s/g, '');
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    reject('The stored GitHub App private key is invalid. Reconnect the app.', 503);
  }
  let keyBytes;
  try {
    keyBytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  } catch {
    reject('The stored GitHub App private key is invalid. Reconnect the app.', 503);
  }
  if (keyBytes.length < 512 || keyBytes.length > 16384 || base64(keyBytes) !== encoded) {
    keyBytes.fill(0);
    reject('The stored GitHub App private key is invalid. Reconnect the app.', 503);
  }
  if (match[1] === 'PRIVATE KEY') return keyBytes;
  // PrivateKeyInfo(version 0, rsaEncryption OID + NULL, OCTET STRING RSAPrivateKey).
  const algorithm = new Uint8Array([0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09,
    0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const octets = der(0x04, keyBytes);
  const content = new Uint8Array(algorithm.length + octets.length);
  content.set(algorithm);
  content.set(octets, algorithm.length);
  const wrapped = der(0x30, content);
  keyBytes.fill(0);
  octets.fill(0);
  content.fill(0);
  return wrapped;
}

async function importSigningKey(pem, cryptoImpl) {
  let bytes;
  try {
    if (typeof pem !== 'string' || pem.length > 32768 || pem.trim().length < 512) {
      reject('The GitHub App private key is invalid. Reconnect the app.', 503);
    }
    bytes = decodePrivateKey(pem.trim());
    const key = await cryptoImpl.subtle.importKey('pkcs8', bytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    if (key.algorithm.modulusLength < 2048 || key.algorithm.modulusLength > 8192) {
      reject('The GitHub App key must use RSA with 2048 to 8192 bits. Reconnect the app.', 503);
    }
    return key;
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    reject('The stored GitHub App private key could not be used. Reconnect the app.', 503);
  } finally {
    bytes?.fill(0);
  }
}

/** Validate actual RSA material before storing a new app; no API call or key export occurs. */
export async function validatePrivateKey(pem, { cryptoImpl = globalThis.crypto } = {}) {
  await importSigningKey(pem, cryptoImpl);
}

function errorMessage(status, headers) {
  if (status === 401) return 'GitHub did not accept the app connection. Reconnect the GitHub App.';
  if ((status === 403 || status === 429) && headers?.get('x-ratelimit-remaining') === '0') {
    return 'GitHub’s API rate limit has been reached. Wait before checking again.';
  }
  if (status === 403) return 'GitHub denied app access. Check the seo-yuna installation and its Contents and Actions write permissions.';
  if (status === 404) return 'GitHub could not find the app installation, seo-yuna, or studio.yml on master. Check the app connection.';
  if (status === 409) return 'GitHub reported a repository conflict. Refresh the collection before trying again.';
  if (status === 422) return 'GitHub rejected the request. Check the installation, repository, and Actions workflow configuration.';
  if (status === 429) return 'GitHub is limiting requests. Wait before trying again.';
  if (status >= 500) return 'GitHub had a server error. Check submission activity before retrying.';
  return `GitHub could not complete the request (HTTP ${status}).`;
}

async function readBounded(response, maximum) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    reject('GitHub returned more data than this server can process in one response.', 502);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (encoder.encode(text).length > maximum) {
      reject('GitHub returned more data than this server can process in one response.', 502);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximum) reject('GitHub returned more data than this server can process in one response.', 502);
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original read failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Instantiate only on the server, after authenticating and authorizing the visitor.
 * Neither returned metadata nor JSON serialization exposes signing keys or tokens.
 */
export class AppGitHubClient {
  #appId;
  #installationId;
  #slug;
  #pem;
  #keyPromise;
  #session;
  #sessionPromise;
  #fetch;
  #crypto;
  #now;
  #timeout;

  constructor(config, { fetchImpl = globalThis.fetch, cryptoImpl = globalThis.crypto,
    now = Date.now, timeoutMs = 35000 } = {}) {
    this.#appId = positiveId(config?.appId);
    this.#installationId = config?.installationId == null ? null : positiveId(config.installationId);
    this.#slug = config?.slug ?? null;
    if (!this.#appId || (config?.installationId != null && !this.#installationId) ||
        (this.#slug !== null && !validSlug(this.#slug)) ||
        typeof config?.privateKey !== 'string' || config.privateKey.length > 32768 ||
        config.privateKey.trim().length < 512) {
      reject('The GitHub App connection is incomplete. Complete app setup before importing.', 503);
    }
    if (typeof fetchImpl !== 'function' || !cryptoImpl?.subtle || typeof now !== 'function' ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 90000) {
      reject('The server cannot initialize its GitHub App connection.', 503);
    }
    this.#pem = config.privateKey.trim();
    this.#fetch = fetchImpl.bind(globalThis);
    this.#crypto = cryptoImpl;
    this.#now = now;
    this.#timeout = timeoutMs;
  }

  #clock() {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) reject('The server clock is unavailable.', 503);
    return value;
  }

  async #signingKey() {
    if (!this.#keyPromise) {
      this.#keyPromise = (async () => {
        const key = await importSigningKey(this.#pem, this.#crypto);
        this.#pem = '';
        return key;
      })();
    }
    return this.#keyPromise;
  }

  async #jwt() {
    const key = await this.#signingKey();
    const seconds = Math.floor(this.#clock() / 1000);
    const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claims = base64url(encoder.encode(JSON.stringify({ iat: seconds - 60,
      exp: seconds + 540, iss: String(this.#appId) })));
    const unsigned = `${header}.${claims}`;
    try {
      const signature = await this.#crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
      return `${unsigned}.${base64url(new Uint8Array(signature))}`;
    } catch {
      reject('The server could not sign the GitHub App request. Reconnect the app.', 503);
    }
  }

  async #request(path, token, { method = 'GET', body, raw = false, timeout = this.#timeout,
    dispatch = false } = {}) {
    if (!(path.startsWith(`${REPO_PATH}/`) || /^\/app\/installations\?per_page=100&page=[1-3]$/.test(path) ||
        /^\/app\/installations\/[1-9][0-9]{0,15}\/access_tokens$/.test(path))) {
      reject('This server can only access its configured GitHub repository.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const headers = {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'seo-yuna-owner',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    };
    try {
      const response = await this.#fetch(`${API_ROOT}${path}`, {
        method, headers, signal: controller.signal, redirect: 'error', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if (response.status === 401 && this.#session?.token === token) this.#session = null;
        try { await response.body?.cancel(); } catch { /* Never read upstream error bodies. */ }
        throw new GitHubError(errorMessage(response.status, response.headers), response.status,
          { uncertain: dispatch && (response.status === 0 || response.status >= 500) });
      }
      // Receipt acceptance survives a 204, malformed body, or body-read interruption.
      if (dispatch) {
        let value;
        try { value = JSON.parse(await readBounded(response, 65536)); } catch { /* Find by request ID. */ }
        const id = positiveId(value?.workflow_run_id);
        return { accepted: true, runId: id };
      }
      if (response.status === 204) return {};
      const text = await readBounded(response, raw ? MAX_CANONICAL_BYTES : MAX_JSON_BYTES);
      return raw ? text : JSON.parse(text);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      // No upstream bodies, request objects, causes, JWTs, or tokens leave this boundary.
      throw new GitHubError(dispatch
        ? 'The connection to GitHub was interrupted. Check submission activity before retrying.'
        : 'The server could not complete its GitHub request. Try checking the connection again.',
      0, { uncertain: dispatch });
    } finally {
      clearTimeout(timer);
    }
  }

  #checkInstallation(installation) {
    if (!positiveId(installation?.id) || !isOwner(installation.account) ||
        positiveId(installation.app_id) !== this.#appId ||
        (installation.target_id != null && positiveId(installation.target_id) !== OWNER_ID) ||
        (installation.target_type != null && installation.target_type !== 'User') ||
        (this.#installationId !== null && positiveId(installation.id) !== this.#installationId) ||
        !validSlug(installation.app_slug) || (this.#slug !== null && installation.app_slug !== this.#slug)) {
      reject('The GitHub App installation does not match the configured owner and seo-yuna connection.', 403);
    }
    if (installation.suspended_at != null || installation.suspended_by != null) {
      reject('The GitHub App installation is suspended. Restore it in GitHub before importing.', 403);
    }
    if (!hasWritePermissions(installation.permissions)) {
      reject('The GitHub App installation needs Contents and Actions read and write access to seo-yuna.', 403);
    }
  }

  async #newSession() {
    const jwt = await this.#jwt();
    const [target, firstPage] = await Promise.all([
      this.#request(`${REPO_PATH}/installation`, jwt),
      this.#request('/app/installations?per_page=100&page=1', jwt),
    ]);
    this.#checkInstallation(target);
    let installations = firstPage;
    let found;
    for (let page = 1; page <= 3; page += 1) {
      if (!Array.isArray(installations) || installations.length > 100) {
        reject('GitHub returned invalid app installation information.', 502);
      }
      found = installations.find(item => positiveId(item?.id) === positiveId(target.id));
      if (found || installations.length < 100 || page === 3) break;
      installations = await this.#request(`/app/installations?per_page=100&page=${page + 1}`, jwt);
    }
    if (!found) reject('The seo-yuna installation was not found for this GitHub App.', 403);
    this.#checkInstallation(found);
    if (found.app_slug !== target.app_slug) reject('GitHub returned inconsistent app installation information.', 502);
    const installationId = positiveId(target.id);
    const result = await this.#request(`/app/installations/${installationId}/access_tokens`, jwt, {
      method: 'POST', body: { repository_ids: [REPOSITORY_ID], permissions: { contents: 'write', actions: 'write' } },
    });
    const expiresAt = typeof result?.expires_at === 'string' ? Date.parse(result.expires_at) : NaN;
    const now = this.#clock();
    if (typeof result?.token !== 'string' || !/^[A-Za-z0-9._-]{1,16384}$/.test(result.token) ||
        !Number.isFinite(expiresAt) || expiresAt <= now + 60000 || expiresAt > now + 65 * 60000 ||
        !hasWritePermissions(result.permissions, true) || result.repository_selection !== 'selected' ||
        !Array.isArray(result.repositories) || result.repositories.length !== 1 || !isRepository(result.repositories[0]) ||
        (result.repositories[0].default_branch != null && result.repositories[0].default_branch !== BRANCH)) {
      reject('GitHub did not issue the expected short-lived access to seo-yuna. Check the app installation.', 403);
    }
    return {
      token: result.token, expiresAt,
      metadata: Object.freeze({ appId: this.#appId, installationId, slug: target.app_slug,
        ownerId: OWNER_ID, owner: OWNER, repositoryId: REPOSITORY_ID, repository: REPOSITORY }),
    };
  }

  async #getSession() {
    if (this.#session && this.#session.expiresAt > this.#clock() + 120000) return this.#session;
    if (!this.#sessionPromise) {
      this.#session = null;
      this.#sessionPromise = this.#newSession().then(session => {
        this.#session = session;
        return session;
      }).finally(() => { this.#sessionPromise = null; });
    }
    return this.#sessionPromise;
  }

  async verifyInstallation() {
    return { ...(await this.#getSession()).metadata };
  }

  async readCanonical() {
    return this.#request(`${REPO_PATH}/contents/data.json?ref=${BRANCH}`,
      (await this.#getSession()).token, { raw: true });
  }

  async stageBlob(source) {
    if (typeof source !== 'string' || !source.length || source.length > MAX_UPLOAD_BYTES ||
        encoder.encode(source).length > MAX_UPLOAD_BYTES) {
      reject('The upload must contain JSON text no larger than 5 MiB.');
    }
    const result = await this.#request(`${REPO_PATH}/git/blobs`, (await this.#getSession()).token, {
      method: 'POST', body: { content: source, encoding: 'utf-8' }, timeout: 90000,
    });
    if (!/^[a-f0-9]{40}$/.test(result?.sha ?? '')) {
      reject('GitHub did not return a valid upload receipt. The batch has not been submitted.', 502);
    }
    return result.sha;
  }

  async dispatch(receipt) {
    if (!/^[a-f0-9]{40}$/.test(receipt?.blobSha ?? '') ||
        !/^[a-f0-9]{64}$/.test(receipt?.digest ?? '') ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(receipt?.requestId ?? '')) {
      reject('The upload receipt is incomplete. Validate and upload the batch again.');
    }
    return this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/dispatches`,
      (await this.#getSession()).token, { method: 'POST', dispatch: true, body: { ref: BRANCH, inputs: {
        payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest,
      } } });
  }

  readRun(id) {
    const runId = positiveId(id);
    if (!runId) reject('Invalid workflow run ID.');
    return this.#getSession().then(session => this.#request(`${REPO_PATH}/actions/runs/${runId}`, session.token));
  }

  readJobs(id) {
    const runId = positiveId(id);
    if (!runId) reject('Invalid workflow run ID.');
    return this.#getSession().then(session => this.#request(
      `${REPO_PATH}/actions/runs/${runId}/jobs?filter=latest&per_page=100`, session.token));
  }

  async findRun(requestId, createdAt) {
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) reject('Invalid submission reference.');
    const created = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
    const date = new Date(created - 300000);
    if (!Number.isFinite(date.getTime())) reject('Invalid submission date.');
    const session = await this.#getSession();
    for (let page = 1; page <= 3; page += 1) {
      const parameters = new URLSearchParams({ event: 'workflow_dispatch', branch: BRANCH,
        created: `>=${date.toISOString()}`, per_page: '100', page: String(page) });
      const result = await this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/runs?${parameters}`, session.token);
      const runs = result?.workflow_runs;
      if (!Array.isArray(runs) || runs.length > 100) reject('GitHub returned invalid workflow run information.', 502);
      const match = runs.find(run => run?.display_title === `Import ${requestId}` && positiveId(run.id));
      if (match) return match;
      if (runs.length < 100) break;
    }
    return null;
  }
}
