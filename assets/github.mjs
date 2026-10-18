export const OWNER = 'budhi-halim';
export const REPO = 'seo-yuna';
export const REPOSITORY = `${OWNER}/${REPO}`;
export const BRANCH = 'master';
export const WORKFLOW = 'studio.yml';
export const API_VERSION = '2026-03-10';
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
const API_ROOT = 'https://api.github.com';
const REPO_PATH = `/repos/${REPOSITORY}`;

export class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.uncertain = status === 0 || status >= 500;
  }
}

function errorMessage(status, headers) {
  if (status === 401) return 'GitHub access has expired or was revoked. Sign in with GitHub again.';
  if (status === 403 && headers?.get('x-ratelimit-remaining') === '0') {
    return 'GitHub’s API rate limit has been reached. Wait before refreshing.';
  }
  if (status === 403) return 'GitHub refused this request. Check that the Seo Yuna GitHub App has Contents and Actions access to seo-yuna.';
  if (status === 404) return 'GitHub could not find seo-yuna or its workflow with this access. Check the selected repository and that studio.yml is on master.';
  if (status === 409) return 'GitHub reported a repository conflict. Refresh the collection and try again.';
  if (status === 422) return 'GitHub rejected the submission. Check that Actions is enabled and studio.yml is available on master.';
  if (status === 429) return 'GitHub is limiting requests. Wait a moment before trying again.';
  if (status >= 500) return 'GitHub had a server error. A submission may still have been accepted; check Activity before retrying.';
  return `GitHub could not complete the request (HTTP ${status}).`;
}

export function runUrl(runId) {
  if (!Number.isSafeInteger(Number(runId)) || Number(runId) <= 0) return `${REPOSITORY_URL}/actions/workflows/${WORKFLOW}`;
  return `${REPOSITORY_URL}/actions/runs/${Number(runId)}`;
}

/** The credential exists only in this instance, never in a URL or persisted receipt. */
export class GitHubClient {
  #token;
  #fetch;

  constructor(token = '', fetchImpl = globalThis.fetch) {
    this.#token = String(token).trim();
    // Native Window.fetch requires the global receiver, not this client instance.
    this.#fetch = fetchImpl.bind(globalThis);
  }

  get connected() { return this.#token.length > 0; }
  disconnect() { this.#token = ''; }

  async #request(path, { method = 'GET', body, raw = false, timeout = 35000 } = {}) {
    if (!(path === '/user' || path === REPO_PATH || path.startsWith(`${REPO_PATH}/`))) {
      throw new GitHubError('This app can only access its configured GitHub repository.');
    }
    const headers = {
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.#fetch(`${API_ROOT}${path}`, {
        method, headers, cache: 'no-store', redirect: 'error',
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new GitHubError(errorMessage(response.status, response.headers), response.status);
      // A successful HTTP dispatch is accepted even if its run-details body is missing.
      if (method === 'POST' && path.endsWith('/dispatches')) {
        let value = {};
        try { value = await response.json(); } catch { /* Recover the run by request ID. */ }
        return { ...value, accepted: true };
      }
      if (response.status === 204) return {};
      return raw ? await response.text() : await response.json();
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      // Do not display upstream bodies, request objects, or credential-bearing errors.
      throw new GitHubError('The connection to GitHub was interrupted. Check Activity before retrying a submission.');
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyConnection() {
    if (!this.connected) throw new GitHubError('Sign in with GitHub to connect.');
    const [user, repository, workflow] = await Promise.all([
      this.#request('/user'),
      this.#request(REPO_PATH),
      this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}`),
    ]);
    if (String(user.login).toLowerCase() !== OWNER) {
      throw new GitHubError(`Connect with the ${OWNER} account that owns this collection.`);
    }
    if (repository.full_name?.toLowerCase() !== REPOSITORY || repository.default_branch !== BRANCH) {
      throw new GitHubError('This app expects budhi-halim/seo-yuna with master as its default branch.');
    }
    if (repository.permissions?.push === false) throw new GitHubError('This account does not have write access to seo-yuna.');
    if (workflow.state !== 'active') throw new GitHubError('The Seo Yuna workflow is disabled. Enable it in the repository’s Actions tab.');
    return { login: user.login };
  }

  readCanonical() {
    return this.#request(`${REPO_PATH}/contents/data.json?ref=${BRANCH}`, { raw: true });
  }

  async stageBlob(text) {
    if (!this.connected) throw new GitHubError('Connect to GitHub before submitting.');
    const blob = await this.#request(`${REPO_PATH}/git/blobs`, {
      method: 'POST', body: { content: text, encoding: 'utf-8' }, timeout: 90000,
    });
    if (!/^[a-f0-9]{40}$/.test(blob.sha ?? '')) throw new GitHubError('GitHub did not return a valid upload receipt. The batch has not been submitted.');
    return blob.sha;
  }

  async dispatch(receipt) {
    if (!this.connected) throw new GitHubError('Connect to GitHub before submitting.');
    if (!/^[a-f0-9]{40}$/.test(receipt.blobSha ?? '') ||
        !/^[a-f0-9]{64}$/.test(receipt.digest ?? '') ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(receipt.requestId ?? '')) {
      throw new GitHubError('The upload receipt is incomplete. Validate and upload the batch again.');
    }
    const result = await this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST', body: { ref: BRANCH, inputs: {
        payload_blob_sha: receipt.blobSha, request_id: receipt.requestId, sha256: receipt.digest,
      } },
    });
    const id = Number(result.workflow_run_id);
    return { accepted: true, runId: Number.isSafeInteger(id) && id > 0 ? id : null };
  }

  readRun(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new GitHubError('Invalid workflow run ID.');
    return this.#request(`${REPO_PATH}/actions/runs/${Number(id)}`);
  }

  readJobs(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new GitHubError('Invalid workflow run ID.');
    return this.#request(`${REPO_PATH}/actions/runs/${Number(id)}/jobs?filter=latest&per_page=100`);
  }

  async findRun(requestId, createdAt) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId ?? '')) throw new GitHubError('Invalid submission reference.');
    const date = new Date(new Date(createdAt).getTime() - 300000);
    if (!Number.isFinite(date.getTime())) throw new GitHubError('Invalid submission date.');
    for (let page = 1; page <= 3; page += 1) {
      const params = new URLSearchParams({ event: 'workflow_dispatch', branch: BRANCH,
        created: `>=${date.toISOString()}`, per_page: '100', page: String(page) });
      const result = await this.#request(`${REPO_PATH}/actions/workflows/${WORKFLOW}/runs?${params}`);
      const runs = result.workflow_runs ?? [];
      const match = runs.find(run => run.display_title === `Import ${requestId}`);
      if (match) return match;
      if (runs.length < 100) break;
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
