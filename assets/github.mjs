import { MAX_IMPORT_BYTES } from './catalog.mjs';

export const OWNER = 'budhi-halim';
export const OWNER_ID = 121861881;
export const REPO = 'seo-yuna';
export const REPOSITORY_ID = 1423899802;
export const REPOSITORY = `${OWNER}/${REPO}`;
export const BRANCH = 'master';
export const WORKFLOW = 'studio.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW}`;
export const API_VERSION = '2026-03-10';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const API_ROOT = 'https://api.github.com';
const REPO_PATH = `/repos/${REPOSITORY}`;
const CATALOG_LIMIT = 16 * 1024 * 1024;
const METADATA_LIMIT = 5 * 1024 * 1024;
const encoder = new TextEncoder();

export class GitHubError extends Error {
  constructor(message, status = 0, uncertain = status === 0 || status >= 500) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.uncertain = uncertain;
  }
}

export function isFineGrainedToken(value) {
  return typeof value === 'string' && value.startsWith('github_pat_') && value.length > 11 &&
    value.length <= 512 && !/[^A-Za-z0-9_]/.test(value);
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function positiveId(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && !/[^0-9]/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function requestId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[^A-Za-z0-9_-]/.test(value);
}
function hex(value, length) { return typeof value === 'string' && value.length === length && !/[^a-f0-9]/.test(value); }
function loginMatches(value) { return typeof value === 'string' && value.toLowerCase() === OWNER; }
function retryAfterSeconds(headers) {
  const value = headers.get('retry-after');
  return typeof value === 'string' && value.length > 0 && value.length <= 10 && !/[^0-9]/.test(value)
    ? Number(value) : null;
}
function rateLimited(status, headers) {
  return status === 429 || (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || retryAfterSeconds(headers) !== null));
}

function errorMessage(status, headers, dispatch) {
  if (status === 401) return 'The saved GitHub token has expired or was revoked. Set up this browser again with a new fine-grained token.';
  if (rateLimited(status, headers)) return 'GitHub is limiting requests. Wait before checking again.';
  if (status === 403) return 'GitHub refused this request. The fine-grained token must select seo-yuna and allow Contents and Actions: read and write.';
  if (status === 404) return 'GitHub could not find seo-yuna or its workflow with this token. Check the selected repository and that studio.yml is on master.';
  if (status === 409) return 'GitHub reported a repository conflict. Refresh the collection and try again.';
  if (status === 422) return 'GitHub rejected the submission. Check that Actions is enabled and studio.yml is available on master.';
  if (status >= 500) return dispatch
    ? 'GitHub had a server error. Acceptance is unconfirmed; check Activity before retrying.'
    : 'GitHub is temporarily unavailable. Please try again.';
  return `GitHub could not complete the request (HTTP ${status}).`;
}

function cancelled(dispatch) {
  return new GitHubError(dispatch
    ? 'The connection to GitHub was interrupted. Check Activity before retrying this submission.'
    : 'The GitHub request was cancelled or timed out. Please try again.', 0, dispatch);
}
function invalidResponse(dispatch = false) {
  return new GitHubError(dispatch
    ? 'GitHub returned an unexpected submission response. Check Activity before retrying.'
    : 'The GitHub response could not be verified. Please try again.', 502, dispatch);
}
function cancelBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* Already closed. */ }
}

async function responseText(response, limit, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > limit) {
    cancelBody(response);
    throw new GitHubError('The GitHub response is larger than this app can process.', 413, false);
  }
  if (!response.body) return '';
  if (typeof response.body.getReader !== 'function') throw invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const stop = () => { try { void reader.cancel().catch(() => {}); } catch { /* Already closed. */ } };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw cancelled(false);
      let item;
      try { item = await reader.read(); } catch { throw invalidResponse(); }
      if (signal.aborted) throw cancelled(false);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) throw invalidResponse();
      size += item.value.byteLength;
      if (size > limit) {
        stop();
        throw new GitHubError('The GitHub response is larger than this app can process.', 413, false);
      }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalidResponse(); }
  } finally {
    signal.removeEventListener('abort', stop);
    try { reader.releaseLock(); } catch { /* Cancellation can release the stream first. */ }
  }
}

function trustedPath(path, method) {
  const url = new URL(path, API_ROOT);
  if (url.origin !== API_ROOT || url.username || url.password || url.hash || `${url.pathname}${url.search}` !== path) return false;
  if (method === 'POST') return !url.search && [`${REPO_PATH}/git/blobs`, `${REPO_PATH}/actions/workflows/${WORKFLOW}/dispatches`].includes(url.pathname);
  if (method !== 'GET') return false;
  if (['/user', REPO_PATH, `${REPO_PATH}/actions/workflows/${WORKFLOW}`].includes(url.pathname)) return !url.search;
  if (url.pathname === `${REPO_PATH}/contents/data.json`) return url.search === `?ref=${BRANCH}`;
  if (url.pathname === `${REPO_PATH}/actions/workflows/${WORKFLOW}/runs`) {
    return [...url.searchParams.keys()].sort().join(',') === 'branch,created,event,page,per_page' &&
      url.searchParams.get('branch') === BRANCH && url.searchParams.get('event') === 'workflow_dispatch' &&
      url.searchParams.get('per_page') === '100' && ['1', '2', '3'].includes(url.searchParams.get('page'));
  }
  const suffix = url.pathname.slice(REPO_PATH.length);
  if (!url.pathname.startsWith(`${REPO_PATH}/`)) return false;
  if (/^\/actions\/runs\/[1-9][0-9]*$/.test(suffix)) return !url.search;
  if (/^\/actions\/runs\/[1-9][0-9]*\/jobs$/.test(suffix)) return url.search === '?filter=latest&per_page=100';
  return false;
}

function validateRun(run, expectedId = null) {
  if (!object(run) || typeof run.id !== 'number' || !positiveId(run.id) || (expectedId !== null && run.id !== expectedId)) throw invalidResponse();
  if (run.path !== undefined && run.path !== WORKFLOW_PATH) throw invalidResponse();
  if (run.head_branch !== undefined && run.head_branch !== BRANCH) throw invalidResponse();
  if (run.repository !== undefined && (!object(run.repository) || run.repository.id !== REPOSITORY_ID ||
      typeof run.repository.full_name !== 'string' || run.repository.full_name.toLowerCase() !== REPOSITORY)) throw invalidResponse();
  return run;
}

export function runUrl(runId) {
  const id = positiveId(runId);
  return id ? `${REPOSITORY_URL}/actions/runs/${id}` : `${REPOSITORY_URL}/actions/workflows/${WORKFLOW}`;
}

/** The token remains private to this instance and is sent only to api.github.com. */
export class GitHubClient {
  #token;
  #fetch;
  #verified = false;
  #generation = 0;
  #controllers = new Set();
  #timeout;
  #uploadTimeout;

  constructor(token = '', fetchImpl = globalThis.fetch, { timeoutMs = 35000, uploadTimeoutMs = 90000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A network implementation is required.');
    if (token !== '' && !isFineGrainedToken(token)) throw new GitHubError('Use a fine-grained GitHub token beginning with github_pat_ for the one-time setup.', 422, false);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 1) throw new TypeError('Request timeouts must be positive integers.');
    this.#token = token;
    this.#fetch = fetchImpl.bind(globalThis);
    this.#timeout = timeoutMs;
    this.#uploadTimeout = uploadTimeoutMs;
  }

  get connected() { return this.#verified && this.#token !== ''; }

  disconnect() {
    this.#generation += 1;
    this.#token = '';
    this.#verified = false;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  async #request(path, { method = 'GET', body, raw = false, timeout = this.#timeout } = {}) {
    if (!trustedPath(path, method)) throw new GitHubError('This app can only access its configured GitHub repository.', 403, false);
    const dispatch = method === 'POST' && path.endsWith('/dispatches');
    const generation = this.#generation;
    const url = `${API_ROOT}${path}`;
    const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    this.#controllers.add(controller);
    let acceptanceConfirmed = false;
    let rejectAbort;
    const abortPromise = new Promise((resolve, reject) => {
      rejectAbort = () => acceptanceConfirmed ? resolve({ accepted: true, runId: null }) : reject(cancelled(dispatch));
    });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    const checkCurrent = () => { if (controller.signal.aborted || generation !== this.#generation) throw cancelled(dispatch); };
    try {
      return await Promise.race([abortPromise, (async () => {
        let response;
        try {
          response = await this.#fetch(url, {
            method, headers, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        } catch { throw cancelled(dispatch); }
        if (controller.signal.aborted || generation !== this.#generation) { cancelBody(response); throw cancelled(dispatch); }
        if (!response || !Number.isInteger(response.status) || typeof response.headers?.get !== 'function') throw invalidResponse(dispatch);
        let wrongURL = false;
        try { wrongURL = Boolean(response.url) && new URL(response.url).href !== url; } catch { wrongURL = true; }
        if (response.type === 'opaqueredirect' || response.redirected || wrongURL || (response.status >= 300 && response.status < 400)) {
          cancelBody(response);
          throw new GitHubError('GitHub returned an unexpected redirect. The request was not followed.', 502, dispatch);
        }
        if (response.status < 200 || response.status > 599) { cancelBody(response); throw invalidResponse(dispatch); }
        if (response.status >= 400) {
          const failure = new GitHubError(errorMessage(response.status, response.headers, dispatch), response.status,
            dispatch && (response.status >= 500 || response.status === 408));
          if (rateLimited(response.status, response.headers)) failure.retryAfterSeconds = retryAfterSeconds(response.headers);
          cancelBody(response);
          if (generation === this.#generation && (response.status === 401 || (response.status === 403 && !rateLimited(response.status, response.headers)))) {
            // Preserve the definite API error while aborting other credentialed requests.
            this.#controllers.delete(controller);
            this.disconnect();
          }
          throw failure;
        }
        // Fine-grained PATs do not use OAuth scopes. An endpoint's
        // X-Accepted-GitHub-Permissions header is not a grant to this token.
        if (!dispatch && headers.Authorization && response.headers.get('x-oauth-scopes')?.trim()) {
          cancelBody(response);
          throw new GitHubError('Use a fine-grained token limited to seo-yuna, with Contents and Actions: read and write.', 403, false);
        }
        if (dispatch) {
          if (![200, 204].includes(response.status)) { cancelBody(response); throw invalidResponse(true); }
          // The optional run-details body cannot turn known HTTP acceptance back
          // into an unknown outcome, even when navigation aborts reading it.
          acceptanceConfirmed = true;
          if (response.status === 204) return { accepted: true, runId: null };
          let result = null;
          try { result = JSON.parse(await responseText(response, METADATA_LIMIT, controller.signal)); } catch { /* HTTP acceptance is enough; recover a missing run ID through Activity. */ }
          checkCurrent();
          return { accepted: true, runId: object(result) ? positiveId(result.workflow_run_id) : null };
        }
        if (response.status === 204) throw invalidResponse();
        const text = await responseText(response, raw ? CATALOG_LIMIT : METADATA_LIMIT, controller.signal);
        checkCurrent();
        if (raw) return text;
        try { return JSON.parse(text); } catch { throw invalidResponse(); }
      })()]);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw cancelled(dispatch);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort);
      this.#controllers.delete(controller);
    }
  }

  async verifyConnection() {
    if (!this.#token) throw new GitHubError('Set up this browser or unlock your local login before connecting.', 401, false);
    const generation = this.#generation;
    this.#verified = false;
    try {
      const user = await this.#request('/user');
      if (!object(user) || user.id !== OWNER_ID || !loginMatches(user.login)) {
        throw new GitHubError(`Use a fine-grained token from the ${OWNER} account that owns this collection.`, 403, false);
      }
      const [repository, workflow] = await Promise.all([
        this.#request(REPO_PATH), this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}`),
      ]);
      if (!object(repository) || repository.id !== REPOSITORY_ID ||
          typeof repository.full_name !== 'string' || repository.full_name.toLowerCase() !== REPOSITORY ||
          !object(repository.owner) || repository.owner.id !== OWNER_ID || !loginMatches(repository.owner.login) ||
          repository.default_branch !== BRANCH) {
        throw new GitHubError('This app expects the original budhi-halim/seo-yuna repository with master as its default branch.', 403, false);
      }
      if (!object(repository.permissions) || repository.permissions.push !== true) throw new GitHubError('The token does not confirm write access to seo-yuna. Check its repository selection and permissions.', 403, false);
      if (!object(workflow) || typeof workflow.id !== 'number' || !positiveId(workflow.id) || workflow.path !== WORKFLOW_PATH) {
        throw new GitHubError('The Seo Yuna workflow could not be verified at .github/workflows/studio.yml.', 403, false);
      }
      if (workflow.state !== 'active') throw new GitHubError('The Seo Yuna workflow is disabled. Enable it in the repository’s Actions tab.', 403, false);
      if (generation !== this.#generation || !this.#token) throw cancelled(false);
      this.#verified = true;
      return { login: OWNER };
    } catch (error) {
      if (generation === this.#generation) this.disconnect();
      throw error;
    }
  }

  readCanonical() { return this.#request(`${REPO_PATH}/contents/data.json?ref=${BRANCH}`, { raw: true }); }

  async stageBlob(text) {
    if (!this.connected) throw new GitHubError('Unlock your local login before submitting JSON.', 401, false);
    if (typeof text !== 'string' || !text.trim()) throw new GitHubError('Provide validated JSON text before uploading.', 422, false);
    if (encoder.encode(text).byteLength > MAX_IMPORT_BYTES) throw new GitHubError('The JSON batch exceeds 5 MiB. Split the batch and try again.', 413, false);
    const blob = await this.#request(`${REPO_PATH}/git/blobs`, { method: 'POST', body: { content: text, encoding: 'utf-8' }, timeout: this.#uploadTimeout });
    if (!object(blob) || !hex(blob.sha, 40)) throw new GitHubError('GitHub did not return a valid upload receipt. The batch has not been submitted.', 502, false);
    return blob.sha;
  }

  async dispatch(receipt) {
    if (!this.connected) throw new GitHubError('Unlock your local login before submitting JSON.', 401, false);
    if (!object(receipt) || !hex(receipt.blobSha, 40) || !hex(receipt.digest, 64) || !requestId(receipt.requestId)) {
      throw new GitHubError('The upload receipt is incomplete. Validate and upload the batch again.', 422, false);
    }
    return this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: BRANCH, inputs: {
      payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest,
    } } });
  }

  async readRun(id) {
    const runId = positiveId(id);
    if (!runId) throw new GitHubError('Invalid workflow run ID.', 422, false);
    return validateRun(await this.#request(`${REPO_PATH}/actions/runs/${runId}`), runId);
  }

  async readJobs(id) {
    const runId = positiveId(id);
    if (!runId) throw new GitHubError('Invalid workflow run ID.', 422, false);
    const value = await this.#request(`${REPO_PATH}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    if (!object(value) || !Array.isArray(value.jobs) || value.jobs.some(job => !object(job) ||
        (job.run_id !== undefined && job.run_id !== runId) || (job.steps !== undefined && (!Array.isArray(job.steps) || job.steps.some(step => !object(step)))))) throw invalidResponse();
    return value;
  }

  async findRun(id, createdAt) {
    if (!requestId(id)) throw new GitHubError('Invalid submission reference.', 422, false);
    if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(createdAt) || /[\r\n]/.test(createdAt)) throw new GitHubError('Invalid submission date.', 422, false);
    const date = new Date(Date.parse(createdAt) - 300000);
    if (!Number.isFinite(date.getTime())) throw new GitHubError('Invalid submission date.', 422, false);
    for (let page = 1; page <= 3; page += 1) {
      const params = new URLSearchParams({ event: 'workflow_dispatch', branch: BRANCH, created: `>=${date.toISOString()}`, per_page: '100', page: String(page) });
      const result = await this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/runs?${params}`);
      if (!object(result) || !Array.isArray(result.workflow_runs)) throw invalidResponse();
      for (const run of result.workflow_runs) {
        validateRun(run);
        if (run.display_title === `Import ${id}` && (run.event === undefined || run.event === 'workflow_dispatch') &&
            (run.actor === undefined || (object(run.actor) && run.actor.id === OWNER_ID && loginMatches(run.actor.login)))) return run;
      }
      if (result.workflow_runs.length < 100) break;
    }
    return null;
  }
}

export function describeRun(run, jobs = []) {
  const steps = jobs.flatMap(job => job.steps ?? []);
  const merged = steps.some(step => step.name === 'Merge into data.json' && step.conclusion === 'success');
  const publishing = steps.some(step => step.name === 'Publish website' && step.status === 'in_progress');
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return { state: 'published', title: 'Published', detail: 'The batch has been processed and the updated website is live.', progress: 100, safe: true, terminal: true };
    if (merged) return { state: 'saved', title: 'Saved · publication incomplete', detail: 'The merge finished in data.json, but publication did not finish. Open the run for details. Retrying this batch safely skips entries already saved.', progress: 75, safe: true, terminal: true };
    const reason = run.conclusion === 'cancelled' ? 'The workflow was cancelled.' : run.conclusion === 'timed_out' ? 'The workflow timed out.' : 'The workflow did not finish successfully.';
    return { state: 'failed', title: 'Import did not complete', detail: `${reason} Open the run to see the validation or processing error before retrying.`, progress: 35, safe: true, terminal: true };
  }
  if (publishing || merged) return { state: 'publishing', title: 'Saved · publishing', detail: 'The merge is complete. GitHub is publishing the updated website.', progress: 80, safe: true, terminal: false };
  if (run.status === 'in_progress') return { state: 'running', title: 'Validating & merging', detail: 'GitHub is checking the full batch and appending accepted entries to data.json.', progress: 55, safe: true, terminal: false };
  return { state: 'queued', title: 'Accepted · queued', detail: 'GitHub has accepted the batch. It will run automatically when the queue is ready.', progress: 30, safe: true, terminal: false };
}
