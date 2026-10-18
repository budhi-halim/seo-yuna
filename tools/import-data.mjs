import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogError, MAX_IMPORT_BYTES, parseCatalog, validateCatalog, mergeCatalog } from '../assets/catalog.mjs';

export const REPOSITORY = 'budhi-halim/seo-yuna';
export const API_VERSION = '2026-03-10';
export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_COMMIT_ATTEMPTS = 4;
const API_ROOT = 'https://api.github.com/repos/' + REPOSITORY;
const META_LIMIT = 2 * 1024 * 1024;
const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export class ImportError extends Error {
  constructor(message, code = 'import_failed') {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export class GitHubApiError extends ImportError {
  constructor(status) {
    const guidance = status === 401 || status === 403
      ? ' Check the workflow token permissions and repository rules.'
      : status === 404 ? ' Check that the requested repository object still exists.' : '';
    super('GitHub API request failed (HTTP ' + status + ').' + guidance, 'github_api_error');
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitBlobSha(bytes) {
  return createHash('sha1').update('blob ' + bytes.byteLength + '\0').update(bytes).digest('hex');
}

function requireSha(value, label = 'Git object SHA') {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new ImportError(label + ' is missing or invalid.', 'invalid_sha');
  }
  return value;
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError('The JSON file must use valid UTF-8 text.', 'invalid_encoding');
  }
}

function parseStoredCatalog(bytes) {
  if (bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new ImportError('The complete catalog exceeds the 16 MiB limit.', 'catalog_too_large');
  }
  let catalog;
  try {
    catalog = JSON.parse(utf8(bytes).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError('The stored data.json is not valid JSON.', 'invalid_stored_json');
  }
  return validateCatalog(catalog);
}

async function boundedBytes(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new ImportError('The GitHub response exceeds the allowed file size.', 'response_too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        throw new ImportError('The GitHub response exceeds the allowed file size.', 'response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

/** All authenticated requests are fixed to the new repository. */
export class GitHubClient {
  constructor({ token, fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new ImportError('The workflow GitHub token is unavailable.', 'missing_token');
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(endpoint, { method = 'GET', body, raw = false, limit = META_LIMIT, accept } = {}) {
    const readable = typeof endpoint === 'string' && (
      endpoint === '/git/ref/heads/master' ||
      /^\/git\/blobs\/[a-f0-9]{40}$/.test(endpoint) ||
      /^\/contents\/data\.json\?ref=[a-f0-9]{40}$/.test(endpoint)
    );
    const writable = endpoint === '/contents/data.json';
    if (!((method === 'GET' && readable) || (method === 'PUT' && writable))) {
      throw new ImportError('An invalid GitHub API path was refused.', 'invalid_api_path');
    }
    let response;
    try {
      response = await this.fetchImpl(API_ROOT + endpoint, {
        method,
        headers: {
          Accept: raw ? 'application/vnd.github.raw+json' : (accept ?? 'application/vnd.github+json'),
          Authorization: 'Bearer ' + this.token,
          'X-GitHub-Api-Version': API_VERSION,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ImportError('The GitHub API request failed because of a network error or timeout.', 'network_error');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GitHubApiError(response.status);
    }
    let bytes;
    try {
      bytes = await boundedBytes(response, limit);
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError('The GitHub response could not be read completely.', 'network_error');
    }
    if (raw) return bytes;
    try {
      return JSON.parse(utf8(bytes));
    } catch {
      throw new ImportError('GitHub returned an invalid API response.', 'invalid_api_response');
    }
  }

  async blob(sha, maximum = MAX_IMPORT_BYTES) {
    requireSha(sha);
    const bytes = await this.request('/git/blobs/' + sha, { raw: true, limit: maximum });
    if (gitBlobSha(bytes) !== sha) {
      throw new ImportError('The downloaded file does not match its Git blob SHA.', 'blob_integrity_error');
    }
    return bytes;
  }

  async snapshot() {
    const reference = await this.request('/git/ref/heads/master');
    const commitSha = requireSha(reference?.object?.sha, 'Master branch commit SHA');
    // Pin the read to one immutable commit, including when master changes mid-request.
    const metadata = await this.request('/contents/data.json?ref=' + commitSha, {
      accept: 'application/vnd.github.object+json',
    });
    if (metadata?.type !== 'file' || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      throw new ImportError('GitHub returned invalid metadata for data.json.', 'invalid_api_response');
    }
    if (metadata.size > MAX_CATALOG_BYTES) {
      throw new ImportError('The complete catalog exceeds the 16 MiB limit.', 'catalog_too_large');
    }
    const blobSha = requireSha(metadata.sha, 'Catalog blob SHA');
    // Blob retrieval also supports files above the Contents API inline-content limit.
    const bytes = await this.blob(blobSha, MAX_CATALOG_BYTES);
    if (bytes.byteLength !== metadata.size) {
      throw new ImportError('The downloaded catalog size does not match its metadata.', 'blob_integrity_error');
    }
    return { commitSha, blobSha, bytes, catalog: parseStoredCatalog(bytes) };
  }

  async update(bytes, blobSha) {
    requireSha(blobSha, 'Previous catalog blob SHA');
    if (bytes.byteLength > MAX_CATALOG_BYTES) {
      throw new ImportError('The complete catalog would exceed the 16 MiB limit.', 'catalog_too_large');
    }
    const result = await this.request('/contents/data.json', {
      method: 'PUT',
      body: {
        message: 'Import prompt catalog batch',
        content: bytes.toString('base64'),
        sha: blobSha,
        branch: 'master',
      },
    });
    return requireSha(result?.commit?.sha, 'Saved catalog commit SHA');
  }
}

export function readDispatch(event, env) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new ImportError('The workflow event must be an object.', 'invalid_event');
  }
  if (env.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new ImportError('This workflow is restricted to budhi-halim/seo-yuna.', 'wrong_repository');
  }
  if (env.GITHUB_REF !== 'refs/heads/master') {
    throw new ImportError('This workflow may run only on the master branch.', 'wrong_branch');
  }
  if (event?.repository?.full_name && event.repository.full_name !== REPOSITORY) {
    throw new ImportError('The event repository does not match the configured repository.', 'wrong_repository');
  }
  if (env.GITHUB_EVENT_NAME === 'push') return { mode: 'publish' };
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new ImportError('This workflow does not accept this event type.', 'wrong_event');
  }
  if (env.GITHUB_ACTOR !== 'budhi-halim' || (event?.sender?.login && event.sender.login !== 'budhi-halim')) {
    throw new ImportError('Only the repository owner may dispatch this workflow.', 'wrong_actor');
  }
  const inputs = event.inputs === undefined ? {} : event.inputs;
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new ImportError('Workflow inputs must be an object.', 'invalid_inputs');
  }
  const allowed = ['payload_blob_sha', 'request_id', 'sha256'];
  if (Object.keys(inputs).some((key) => !allowed.includes(key))) {
    throw new ImportError('The workflow received an unknown input.', 'invalid_inputs');
  }
  const values = allowed.map((key) => Object.hasOwn(inputs, key) ? inputs[key] : '');
  if (values.some((value) => typeof value !== 'string')) {
    throw new ImportError('Workflow inputs must be strings.', 'invalid_inputs');
  }
  if (values.every((value) => value === '')) return { mode: 'publish' };
  const [blobSha, requestId, sha256] = values;
  if (!SHA_PATTERN.test(blobSha) || !REQUEST_PATTERN.test(requestId) || !SHA256_PATTERN.test(sha256)) {
    throw new ImportError('An import requires a valid blob SHA, request ID, and SHA-256 checksum together.', 'invalid_inputs');
  }
  return { mode: 'import', blobSha, requestId, sha256 };
}

async function context(env) {
  if (!env.GITHUB_EVENT_PATH) throw new ImportError('The workflow event file is unavailable.', 'missing_event');
  let event;
  try {
    const bytes = await readFile(env.GITHUB_EVENT_PATH);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('Oversized event');
    event = JSON.parse(utf8(bytes));
  } catch {
    throw new ImportError('The workflow event file could not be read as JSON.', 'invalid_event');
  }
  return readDispatch(event, env);
}

function payloadPath(request, env) {
  if (!env.RUNNER_TEMP) throw new ImportError('The runner temporary directory is unavailable.', 'missing_runner_temp');
  return path.join(env.RUNNER_TEMP, 'seo-yuna-' + request.sha256 + '.payload');
}

function verifyPayload(bytes, request) {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportError('The JSON upload exceeds the 5 MiB limit.', 'import_too_large');
  }
  if (sha256Hex(bytes) !== request.sha256 || gitBlobSha(bytes) !== request.blobSha) {
    throw new ImportError('The upload checksum does not match the submitted file.', 'checksum_mismatch');
  }
  return parseCatalog(utf8(bytes));
}

async function actionOutputs(values, env) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) {
      throw new ImportError('An invalid workflow output was refused.', 'invalid_output');
    }
    return key + '=' + String(value) + '\n';
  });
  await appendFile(env.GITHUB_OUTPUT, lines.join(''), 'utf8');
}

async function summary(title, rows, env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  // Titles and labels are fixed by this script; values are counts only.
  const safeRows = rows.map(([label, count]) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new ImportError('An invalid summary count was refused.');
    return '| ' + label + ' | ' + count + ' |';
  });
  await appendFile(env.GITHUB_STEP_SUMMARY,
    '### ' + title + '\n\n| Result | Count |\n| --- | ---: |\n' + safeRows.join('\n') + '\n\n', 'utf8');
}

async function atomicCatalogWrite(directory, bytes) {
  const target = path.join(directory, 'data.json');
  const temporary = path.join(directory, '.data-import-' + process.pid + '.tmp');
  await writeFile(temporary, bytes, { mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * One Contents API update is atomic. A conflict causes a fresh read and a new
 * merge, never a blind overwrite or a replay of stale serialized contents.
 */
export async function mergeRemoteCatalog({
  incoming, client, directory = PROJECT_ROOT, log = console.log,
  sleep = delay, maximumAttempts = MAX_COMMIT_ATTEMPTS,
}) {
  validateCatalog(incoming);
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 10) {
    throw new ImportError('The commit retry limit is invalid.', 'invalid_retry_limit');
  }
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    log('[Merge] Attempt ' + attempt + '/' + maximumAttempts + ': reading the current master catalog.');
    const snapshot = await client.snapshot();
    const result = mergeCatalog(snapshot.catalog, incoming);
    if (!result.changed) {
      await atomicCatalogWrite(directory, snapshot.bytes);
      log('[Merge] No changes needed; ' + result.duplicateVariations + ' identical prompts already exist.');
      return { ...result, commitSha: snapshot.commitSha, attempts: attempt };
    }
    const bytes = Buffer.from(JSON.stringify(result.catalog, null, 2) + '\n', 'utf8');
    if (bytes.byteLength > MAX_CATALOG_BYTES) {
      throw new ImportError('The complete catalog would exceed the 16 MiB limit.', 'catalog_too_large');
    }
    let commitSha;
    try {
      commitSha = await client.update(bytes, snapshot.blobSha);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 409) throw error;
      if (attempt === maximumAttempts) {
        throw new ImportError('The catalog kept changing during import. Nothing was overwritten; retry this batch.', 'commit_conflict');
      }
      log('[Merge] Master changed during the update. Reading it again before retrying.');
      await sleep(Math.min(1000 * (2 ** (attempt - 1)), 8000));
      continue;
    }
    await atomicCatalogWrite(directory, bytes);
    log('[Merge] Saved ' + result.addedThemes + ' new themes and ' + result.addedVariations + ' new prompts.');
    return { ...result, commitSha, attempts: attempt };
  }
  throw new ImportError('The import ended without a result.');
}

export async function runValidation({ env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const request = await context(env);
  if (request.mode === 'publish') {
    log('[Validation] Publish-only run; no JSON batch was submitted.');
    await actionOutputs({ import_requested: false }, env);
    return request;
  }
  log('[Validation] Downloading and verifying the JSON batch (5 MiB maximum).');
  const client = new GitHubClient({ token: env.GITHUB_TOKEN, fetchImpl });
  const bytes = await client.blob(request.blobSha, MAX_IMPORT_BYTES);
  const incoming = verifyPayload(bytes, request);
  const destination = payloadPath(request, env);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode: 0o600 });
  const variations = incoming.reduce((total, theme) => total + theme.variations.length, 0);
  log('[Validation] Verified ' + incoming.length + ' themes and ' + variations + ' prompts.');
  await actionOutputs({ import_requested: true }, env);
  await summary('JSON batch validated', [['Themes in batch', incoming.length], ['Prompts in batch', variations]], env);
  return request;
}

export async function runMerge({
  env = process.env, fetchImpl = globalThis.fetch, directory = PROJECT_ROOT,
  log = console.log, sleep = delay,
} = {}) {
  const started = performance.now();
  const request = await context(env);
  if (request.mode !== 'import') {
    throw new ImportError('Merge requires a validated import batch.', 'missing_import');
  }
  let bytes;
  try {
    bytes = await readFile(payloadPath(request, env));
  } catch {
    throw new ImportError('The validated upload is unavailable. Re-run validation before merging.', 'missing_payload');
  }
  const incoming = verifyPayload(bytes, request);
  const client = new GitHubClient({ token: env.GITHUB_TOKEN, fetchImpl });
  const result = await mergeRemoteCatalog({ incoming, client, directory, log, sleep });
  await actionOutputs({
    commit_sha: result.commitSha,
    changed: result.changed,
    added_themes: result.addedThemes,
    added_variations: result.addedVariations,
    duplicate_variations: result.duplicateVariations,
    extended_themes: result.extendedThemes,
  }, env);
  await summary('Catalog import completed', [
    ['New themes', result.addedThemes],
    ['New prompts', result.addedVariations],
    ['Existing themes extended', result.extendedThemes],
    ['Identical prompts skipped', result.duplicateVariations],
  ], env);
  log('[Merge] Complete in ' + ((performance.now() - started) / 1000).toFixed(1) + ' seconds.');
  return result;
}

async function main() {
  const command = process.argv[2];
  if (command === '--help' || command === '-h') {
    console.log('Usage: node tools/import-data.mjs validate|merge\nRuns in the authorized GitHub workflow context. Validation stages a verified upload in RUNNER_TEMP; merge commits only data.json.');
    return;
  }
  if (command === 'validate') return runValidation();
  if (command === 'merge') return runMerge();
  throw new ImportError('Usage: node tools/import-data.mjs validate|merge', 'invalid_command');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const known = error instanceof ImportError || error instanceof CatalogError;
    console.error('Import failed: ' + (known ? error.message : 'An unexpected local error occurred.'));
    process.exitCode = 1;
  });
}
