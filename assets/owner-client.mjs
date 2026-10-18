import { GitHubClient, GitHubError, OWNER, isFineGrainedToken } from './github.mjs';
import { CredentialVault, CredentialVaultError } from './credential-vault.mjs';

export class OwnerAccessError extends Error {
  constructor(message, status = 0, uncertain = false) {
    super(message);
    this.name = 'OwnerAccessError';
    this.status = status;
    this.uncertain = uncertain;
  }
}

function cancelled() { return new OwnerAccessError('The local login operation was cancelled.', 0, false); }
function failure(error, fallback = 'The local login operation could not be completed. Please try again.') {
  if (error instanceof OwnerAccessError) return error;
  if (error instanceof CredentialVaultError) {
    const safe = new CredentialVaultError(error.code);
    return new OwnerAccessError(safe.message, error.code === 'unlock_failed' ? 401 : 0, false);
  }
  if (error instanceof GitHubError) {
    const safe = new OwnerAccessError(error.message, error.status, error.uncertain);
    if (Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) safe.retryAfterSeconds = error.retryAfterSeconds;
    return safe;
  }
  return new OwnerAccessError(fallback, 0, false);
}
function validString(value, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max * 2) return false;
  let count = 0;
  for (const _character of value) if (++count > max) return false;
  return count >= min;
}

/**
 * The two local login strings unlock a device-local encrypted token. They never
 * leave this module for a network request; GitHub still authorizes every write.
 */
export class OwnerClient {
  #vault;
  #fetch;
  #options;
  #public;
  #client = null;
  #pending = new Set();
  #generation = 0;

  constructor({ fetchImpl = globalThis.fetch, storage, cryptoImpl, vault,
    timeoutMs = 35000, uploadTimeoutMs = 90000, lifecycleTarget = globalThis.window } = {}) {
    this.#fetch = fetchImpl;
    this.#options = { timeoutMs, uploadTimeoutMs };
    this.#public = new GitHubClient('', fetchImpl, this.#options);
    this.#vault = vault ?? new CredentialVault({ storage, cryptoImpl });
    if (!['load', 'save', 'unlock', 'cancel', 'forget'].every(method => typeof this.#vault?.[method] === 'function')) {
      throw new TypeError('A local credential vault is required.');
    }
    // Also protect callers that forget to install their own pagehide handler.
    lifecycleTarget?.addEventListener?.('pagehide', () => this.disconnect());
  }

  get configured() { return this.#vault.configured === true; }
  get storageAvailable() { return this.#vault.available === true; }
  get storageError() {
    const error = this.#vault.error;
    return error instanceof CredentialVaultError ? new CredentialVaultError(error.code).message :
      error ? 'Saved local login data is unavailable in this browser.' : '';
  }
  get connected() { return this.#client?.connected === true; }
  get authorized() { return this.connected; }
  get login() { return this.connected ? OWNER : null; }

  #state() {
    return { configured: this.configured, storageAvailable: this.storageAvailable, storageError: this.storageError,
      connected: this.connected, authorized: this.authorized, login: this.login };
  }
  #current(generation) { if (generation !== this.#generation) throw cancelled(); }

  disconnect() {
    this.#generation += 1;
    this.#vault.cancel();
    this.#client?.disconnect();
    this.#client = null;
    for (const client of this.#pending) client.disconnect();
    this.#pending.clear();
  }
  logout() { this.disconnect(); return this.#state(); }

  async initialize() {
    this.disconnect();
    const generation = this.#generation;
    try {
      await this.#vault.load();
      this.#current(generation);
    } catch (error) {
      this.#current(generation);
      // Startup remains usable for public browsing even if local storage is blocked
      // or the encrypted record needs an explicit reset. The getters explain why.
      if (!(error instanceof CredentialVaultError)) throw failure(error);
    }
    return this.#state();
  }

  async configure(username, password, token) {
    this.disconnect();
    const generation = this.#generation;
    let candidate = null;
    try {
      if (!validString(username, 1, 256) || !validString(password, 12, 1024)) throw new CredentialVaultError('invalid_credentials');
      if (!isFineGrainedToken(token)) throw new CredentialVaultError('invalid_token');
      if (!this.storageAvailable) throw this.#vault.error ?? new CredentialVaultError('storage_unavailable');
      candidate = new GitHubClient(token, this.#fetch, this.#options);
      this.#pending.add(candidate);
      await candidate.verifyConnection();
      this.#current(generation);
      await this.#vault.save(username, password, token);
      this.#current(generation);
      if (!candidate.connected) throw cancelled();
      this.#pending.delete(candidate);
      this.#client = candidate;
      return this.#state();
    } catch (error) {
      this.#current(generation);
      throw failure(error);
    } finally {
      if (candidate !== this.#client) candidate?.disconnect();
      this.#pending.delete(candidate);
      username = ''; password = ''; token = '';
    }
  }

  async unlock(username, password) {
    this.disconnect();
    const generation = this.#generation;
    let token = '';
    let candidate = null;
    try {
      token = await this.#vault.unlock(username, password);
      this.#current(generation);
      candidate = new GitHubClient(token, this.#fetch, this.#options);
      token = '';
      this.#pending.add(candidate);
      await candidate.verifyConnection();
      this.#current(generation);
      if (!candidate.connected) throw cancelled();
      this.#pending.delete(candidate);
      this.#client = candidate;
      return this.#state();
    } catch (error) {
      this.#current(generation);
      throw failure(error);
    } finally {
      if (candidate !== this.#client) candidate?.disconnect();
      this.#pending.delete(candidate);
      username = ''; password = ''; token = '';
    }
  }

  forget() {
    this.disconnect();
    try { this.#vault.forget(); } catch (error) { throw failure(error, 'The saved local login could not be removed. Please try again.'); }
    return this.#state();
  }

  async #use(operation, write = false) {
    if (write && !this.connected) throw new OwnerAccessError('Unlock your local login before submitting JSON.', 401, false);
    const client = this.connected ? this.#client : this.#public;
    try { return await operation(client); }
    catch (error) {
      // An old request must never sign out a newer connection. GitHubClient clears
      // its token on an authentication failure, but retains it for rate limiting.
      if (client === this.#client && !client.connected) this.disconnect();
      throw failure(error, 'The GitHub request could not be completed. Please try again.');
    }
  }

  readCanonical() { return this.#use(client => client.readCanonical()); }
  readRun(id) { return this.#use(client => client.readRun(id)); }
  readJobs(id) { return this.#use(client => client.readJobs(id)); }
  findRun(requestId, createdAt) { return this.#use(client => client.findRun(requestId, createdAt)); }
  stageBlob(source) { return this.#use(client => client.stageBlob(source), true); }
  dispatch(receipt) { return this.#use(client => client.dispatch(receipt), true); }
}
