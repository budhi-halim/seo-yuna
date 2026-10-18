/** Device-local encryption only. GitHub still authorizes every repository write. */
export const VAULT_STORAGE_KEY = 'seo-yuna:credential-vault:v1';
export const CREDENTIAL_VAULT_KEY = VAULT_STORAGE_KEY;

const DOMAIN = 'seo-yuna:credential-vault';
const VERSION = 1;
const REPOSITORY = 'budhi-halim/seo-yuna';
const KDF = 'PBKDF2-HMAC-SHA256';
const ITERATIONS = 600_000;
const CIPHER = 'AES-256-GCM';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN_PREFIX = 'github_pat_';
const MAX_TOKEN_BYTES = 512;
const MAX_RECORD_CHARACTERS = 2048;
const RECORD_FIELDS = ['version', 'repository', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'ciphertext'];

const MESSAGES = Object.freeze({
  storage_unavailable: 'This browser cannot access saved sign-in data. Check its storage settings and try again.',
  crypto_unavailable: 'Secure sign-in storage is unavailable in this browser. Use an up-to-date browser over HTTPS.',
  vault_corrupt: 'The saved sign-in data has an invalid format. Set up this browser again.',
  invalid_credentials: 'Use a username of 1–256 characters and a password of 12–1024 characters. Both strings are case-sensitive.',
  invalid_token: 'Use a fine-grained GitHub token beginning with github_pat_.',
  not_configured: 'Set up this browser before signing in.',
  unlock_failed: 'The saved sign-in data could not be unlocked. Check both strings or set up this browser again.',
  cancelled: 'The sign-in operation was cancelled.',
  storage_changed: 'The saved sign-in data changed during this operation. Try again.',
  crypto_failed: 'This browser could not secure the sign-in data. Try again.',
});

export class CredentialVaultError extends Error {
  constructor(code = 'crypto_failed') {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'crypto_failed';
    super(MESSAGES[safeCode]);
    this.name = 'CredentialVaultError';
    this.code = safeCode;
  }
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(maximum / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CredentialVaultError('vault_corrupt');
  }
  let binary;
  try { binary = atob(value); } catch { throw new CredentialVaultError('vault_corrupt'); }
  if (binary.length < minimum || binary.length > maximum) throw new CredentialVaultError('vault_corrupt');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64(bytes) !== value) throw new CredentialVaultError('vault_corrupt');
  return bytes;
}

function parseRecord(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RECORD_CHARACTERS) throw new CredentialVaultError('vault_corrupt');
  let record;
  try { record = JSON.parse(raw); } catch { throw new CredentialVaultError('vault_corrupt'); }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== RECORD_FIELDS.length ||
      !RECORD_FIELDS.every(field => Object.hasOwn(record, field)) ||
      record.version !== VERSION || record.repository !== REPOSITORY || record.kdf !== KDF ||
      record.iterations !== ITERATIONS || record.cipher !== CIPHER) {
    throw new CredentialVaultError('vault_corrupt');
  }
  return {
    raw,
    salt: decodeBase64(record.salt, SALT_BYTES, SALT_BYTES),
    iv: decodeBase64(record.iv, IV_BYTES, IV_BYTES),
    ciphertext: decodeBase64(record.ciphertext, TOKEN_PREFIX.length + 1 + TAG_BYTES, MAX_TOKEN_BYTES + TAG_BYTES),
  };
}

function validString(value, minimum, maximum) {
  // Bound allocation first. Count Unicode code points, without normalization or trimming.
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum * 2) return false;
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return length >= minimum;
}

function validCredentials(username, password) {
  return validString(username, 1, 256) && validString(password, 12, 1024);
}

function validToken(token) {
  // An explicit disallowed-character check also rejects a trailing CR/LF.
  return typeof token === 'string' && token.length > TOKEN_PREFIX.length && token.length <= MAX_TOKEN_BYTES &&
    token.startsWith(TOKEN_PREFIX) && !/[^A-Za-z0-9_]/.test(token);
}

function additionalData() {
  return new TextEncoder().encode(JSON.stringify([DOMAIN, VERSION, REPOSITORY, KDF, ITERATIONS, CIPHER]));
}

/**
 * Only the token is encrypted; neither sign-in string nor a password verifier is stored.
 * Call cancel() on lock/navigation and also guard the caller's own authentication epoch.
 * A later operation supersedes an earlier one. Cancellation cannot abort WebCrypto, but
 * its result is discarded before persistence or return. No token is retained by this class.
 */
export class CredentialVault {
  #storage = null;
  #crypto = null;
  #storageAvailable = false;
  #record = null;
  #error = null;
  #generation = 0;

  constructor(options = {}) {
    // Access default browser storage inside try: its getter can throw in restricted contexts.
    try {
      const storage = options.storage === undefined ? globalThis.localStorage : options.storage;
      const get = storage?.getItem;
      const set = storage?.setItem;
      const remove = storage?.removeItem;
      if (typeof get !== 'function' || typeof set !== 'function' || typeof remove !== 'function') throw new Error();
      this.#storage = { get: get.bind(storage), set: set.bind(storage), remove: remove.bind(storage) };
      this.#storageAvailable = true;
    } catch { this.#error = new CredentialVaultError('storage_unavailable'); }
    try {
      const crypto = options.cryptoImpl === undefined ? globalThis.crypto : options.cryptoImpl;
      const subtle = crypto?.subtle;
      if (typeof crypto?.getRandomValues !== 'function' ||
          !['importKey', 'deriveKey', 'encrypt', 'decrypt'].every(method => typeof subtle?.[method] === 'function') ||
          typeof globalThis.btoa !== 'function' || typeof globalThis.atob !== 'function') throw new Error();
      this.#crypto = {
        random: crypto.getRandomValues.bind(crypto),
        importKey: subtle.importKey.bind(subtle), deriveKey: subtle.deriveKey.bind(subtle),
        encrypt: subtle.encrypt.bind(subtle), decrypt: subtle.decrypt.bind(subtle),
      };
    } catch { this.#error ??= new CredentialVaultError('crypto_unavailable'); }
  }

  get configured() { return this.#record !== null; }
  get available() { return this.#storage !== null && this.#storageAvailable && this.#crypto !== null; }
  get error() { return this.#error; }

  #current(generation) {
    if (generation !== this.#generation) throw new CredentialVaultError('cancelled');
  }

  #requireCrypto() {
    if (!this.#crypto) throw new CredentialVaultError('crypto_unavailable');
  }

  #readRaw() {
    try {
      if (!this.#storage) throw new Error();
      const raw = this.#storage.get(VAULT_STORAGE_KEY);
      if (raw !== null && typeof raw !== 'string') throw new Error();
      this.#storageAvailable = true;
      return raw;
    } catch {
      this.#storageAvailable = false;
      throw new CredentialVaultError('storage_unavailable');
    }
  }

  #readRecord() {
    const raw = this.#readRaw();
    try {
      const record = raw === null ? null : parseRecord(raw);
      this.#record = raw;
      return record;
    } catch (error) {
      this.#record = null;
      throw error;
    }
  }

  #unchanged(raw, generation) {
    this.#current(generation);
    if (this.#readRaw() !== raw) throw new CredentialVaultError('storage_changed');
    this.#current(generation);
  }

  #write(raw) {
    try {
      if (this.#storage.set(VAULT_STORAGE_KEY, raw) !== undefined || this.#readRaw() !== raw) throw new Error();
    } catch {
      this.#storageAvailable = false;
      throw new CredentialVaultError('storage_unavailable');
    }
  }

  #failure(error, generation, fallback) {
    if (generation !== this.#generation) return new CredentialVaultError('cancelled');
    // Recreate even our own errors so injected exceptions cannot expose a modified message/cause.
    const safe = new CredentialVaultError(error instanceof CredentialVaultError ? error.code : fallback);
    this.#error = safe;
    return safe;
  }

  async #derive(username, password, salt, generation) {
    // JSON escaping preserves exact strings, including lone surrogates, and prevents
    // ambiguous pairs such as ('ab', 'c…') and ('a', 'bc…') from producing the same key.
    const material = new TextEncoder().encode(JSON.stringify([DOMAIN, VERSION, 'credentials', username, password]));
    let base;
    try {
      base = await this.#crypto.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
    } finally { material.fill(0); }
    this.#current(generation);
    const key = await this.#crypto.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    this.#current(generation);
    return key;
  }

  async load() {
    const generation = ++this.#generation;
    try {
      this.#readRecord();
      this.#requireCrypto();
      this.#current(generation);
      this.#error = null;
      return { configured: this.configured, available: this.available };
    } catch (error) { throw this.#failure(error, generation, 'vault_corrupt'); }
  }

  async save(username, password, token) {
    const generation = ++this.#generation;
    try {
      if (!validCredentials(username, password)) throw new CredentialVaultError('invalid_credentials');
      if (!validToken(token)) throw new CredentialVaultError('invalid_token');
      const previous = this.#readRaw();
      this.#requireCrypto();
      const salt = this.#crypto.random(new Uint8Array(SALT_BYTES));
      const iv = this.#crypto.random(new Uint8Array(IV_BYTES));
      const key = await this.#derive(username, password, salt, generation);
      const plaintext = new TextEncoder().encode(token);
      let ciphertext;
      try {
        ciphertext = new Uint8Array(await this.#crypto.encrypt(
          { name: 'AES-GCM', iv, tagLength: TAG_BYTES * 8, additionalData: additionalData() }, key, plaintext));
      } finally { plaintext.fill(0); }
      const raw = JSON.stringify({ version: VERSION, repository: REPOSITORY, kdf: KDF, iterations: ITERATIONS,
        cipher: CIPHER, salt: encodeBase64(salt), iv: encodeBase64(iv), ciphertext: encodeBase64(ciphertext) });
      parseRecord(raw);
      // This is the final synchronous boundary before persistence. No await follows it.
      this.#unchanged(previous, generation);
      this.#write(raw);
      this.#current(generation);
      this.#record = raw;
      this.#error = null;
    } catch (error) { throw this.#failure(error, generation, 'crypto_failed'); }
  }

  async unlock(username, password) {
    const generation = ++this.#generation;
    let plaintext;
    try {
      const record = this.#readRecord();
      if (!record) throw new CredentialVaultError('not_configured');
      if (!validCredentials(username, password)) throw new CredentialVaultError('unlock_failed');
      this.#requireCrypto();
      const key = await this.#derive(username, password, record.salt, generation);
      plaintext = new Uint8Array(await this.#crypto.decrypt(
        { name: 'AES-GCM', iv: record.iv, tagLength: TAG_BYTES * 8, additionalData: additionalData() }, key, record.ciphertext));
      this.#unchanged(record.raw, generation);
      const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      if (!validToken(token)) throw new CredentialVaultError('unlock_failed');
      this.#current(generation);
      this.#error = null;
      return token;
    } catch (error) { throw this.#failure(error, generation, 'unlock_failed'); }
    finally { plaintext?.fill(0); }
  }

  cancel() { this.#generation += 1; }

  forget() {
    const generation = ++this.#generation;
    try {
      if (!this.#storage || this.#storage.remove(VAULT_STORAGE_KEY) !== undefined || this.#readRaw() !== null) {
        this.#storageAvailable = false;
        throw new CredentialVaultError('storage_unavailable');
      }
      this.#current(generation);
      this.#record = null;
      this.#error = this.#crypto ? null : new CredentialVaultError('crypto_unavailable');
    } catch (error) {
      this.#storageAvailable = false;
      throw this.#failure(error, generation, 'storage_unavailable');
    }
  }
}
