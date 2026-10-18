import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CredentialVault, CredentialVaultError, VAULT_STORAGE_KEY, CREDENTIAL_VAULT_KEY } from '../assets/credential-vault.mjs';

const USERNAME = 'Maple lantern username';
const PASSWORD = 'river cloud apricot lantern';
const TOKEN = 'github_pat_fixture_owner_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class MemoryStorage {
  values = new Map();
  writes = [];
  removals = [];
  failure = null;
  getItem(key) {
    if (this.failure === 'read') throw new Error(`storage exception ${TOKEN} ${PASSWORD}`);
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    if (this.failure === 'write') throw new Error(`quota exception ${TOKEN} ${PASSWORD}`);
    this.writes.push({ key, value });
    this.values.set(key, value);
  }
  removeItem(key) {
    if (this.failure === 'remove') throw new Error(`remove exception ${TOKEN} ${PASSWORD}`);
    this.removals.push(key);
    this.values.delete(key);
  }
}

function fixture(options = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const vault = new CredentialVault({ storage, cryptoImpl: options.cryptoImpl ?? webcrypto });
  return { vault, storage };
}

const rejectsCode = (operation, code) => assert.rejects(operation, error => {
  assert.ok(error instanceof CredentialVaultError);
  assert.equal(error.code, code);
  for (const secret of [USERNAME, PASSWORD, TOKEN]) assert.ok(!error.message.includes(secret));
  assert.equal(error.cause, undefined);
  return true;
});

function instrumentCrypto(hooks = {}) {
  const calls = { random: [], imports: [], derivations: [], encryptions: [], decryptions: [] };
  const cryptoImpl = {
    getRandomValues(value) {
      assert.equal(this, cryptoImpl);
      calls.random.push(value.byteLength);
      return webcrypto.getRandomValues(value);
    },
    subtle: {
      async importKey(...args) {
        assert.equal(this, cryptoImpl.subtle);
        const key = await webcrypto.subtle.importKey(...args);
        calls.imports.push({ format: args[0], input: new Uint8Array(args[1]).slice(), key });
        return hooks.importKey ? hooks.importKey(key, args) : key;
      },
      async deriveKey(...args) {
        assert.equal(this, cryptoImpl.subtle);
        calls.derivations.push(args);
        const key = await webcrypto.subtle.deriveKey(...args);
        return hooks.deriveKey ? hooks.deriveKey(key, args) : key;
      },
      async encrypt(...args) {
        assert.equal(this, cryptoImpl.subtle);
        calls.encryptions.push(args);
        return hooks.encrypt ? hooks.encrypt(args) : webcrypto.subtle.encrypt(...args);
      },
      async decrypt(...args) {
        assert.equal(this, cryptoImpl.subtle);
        calls.decryptions.push(args);
        return hooks.decrypt ? hooks.decrypt(args) : webcrypto.subtle.decrypt(...args);
      },
    },
  };
  return { cryptoImpl, calls };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('real WebCrypto round trip survives a new vault instance and stores only an encrypted token', async () => {
  const { vault, storage } = fixture();
  assert.deepEqual(await vault.load(), { configured: false, available: true });
  assert.equal(await vault.save(USERNAME, PASSWORD, TOKEN), undefined);
  assert.equal(vault.configured, true);
  assert.equal(vault.error, null);
  assert.equal(CREDENTIAL_VAULT_KEY, VAULT_STORAGE_KEY);
  assert.deepEqual([...storage.values.keys()], [VAULT_STORAGE_KEY]);
  const serialized = storage.values.get(VAULT_STORAGE_KEY);
  for (const secret of [USERNAME, PASSWORD, TOKEN]) {
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(Buffer.from(secret).toString('base64')));
  }
  assert.deepEqual(Object.keys(JSON.parse(serialized)).sort(),
    ['version', 'repository', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'ciphertext'].sort());
  assert.deepEqual(Object.keys(vault), []);
  const reopened = new CredentialVault({ storage, cryptoImpl: webcrypto });
  assert.deepEqual(await reopened.load(), { configured: true, available: true });
  assert.equal(await reopened.unlock(USERNAME, PASSWORD), TOKEN);
  assert.equal(storage.writes.length, 1, 'Unlocking must not rewrite or persist any input');
});

test('fresh saves use independent random salt/IV and fixed nonextractable PBKDF2 and AES-GCM keys', async () => {
  const { cryptoImpl, calls } = instrumentCrypto();
  const { vault, storage } = fixture({ cryptoImpl });
  await vault.save(USERNAME, PASSWORD, TOKEN);
  const first = JSON.parse(storage.values.get(VAULT_STORAGE_KEY));
  await vault.save(USERNAME, PASSWORD, TOKEN);
  const second = JSON.parse(storage.values.get(VAULT_STORAGE_KEY));
  for (const field of ['salt', 'iv', 'ciphertext']) assert.notEqual(first[field], second[field]);
  assert.deepEqual(calls.random, [16, 12, 16, 12]);
  for (const imported of calls.imports) {
    assert.equal(imported.key.extractable, false);
    assert.deepEqual(imported.key.usages, ['deriveKey']);
  }
  for (const [algorithm, _base, target, extractable, usages] of calls.derivations) {
    assert.equal(algorithm.name, 'PBKDF2');
    assert.equal(algorithm.hash, 'SHA-256');
    assert.equal(algorithm.iterations, 600_000);
    assert.equal(algorithm.salt.byteLength, 16);
    assert.deepEqual(target, { name: 'AES-GCM', length: 256 });
    assert.equal(extractable, false);
    assert.deepEqual(usages, ['encrypt', 'decrypt']);
  }
  for (const [algorithm, key, plaintext] of calls.encryptions) {
    assert.equal(key.extractable, false);
    assert.equal(algorithm.tagLength, 128);
    assert.equal(algorithm.iv.byteLength, 12);
    assert.ok(new TextDecoder().decode(algorithm.additionalData).includes('budhi-halim/seo-yuna'));
    assert.ok(plaintext.every(byte => byte === 0), 'Temporary token buffers are cleared');
  }
});

test('wrong username, wrong password, case changes, and ciphertext tampering have the same generic failure', async () => {
  const { vault, storage } = fixture();
  await vault.save(USERNAME, PASSWORD, TOKEN);
  for (const [username, password] of [[`${USERNAME}x`, PASSWORD], [USERNAME, `${PASSWORD}x`],
    [USERNAME.toUpperCase(), PASSWORD], [USERNAME, PASSWORD.toUpperCase()], ['', PASSWORD], [USERNAME, 'short']]) {
    await rejectsCode(vault.unlock(username, password), 'unlock_failed');
    assert.equal(vault.configured, true);
  }
  const record = JSON.parse(storage.values.get(VAULT_STORAGE_KEY));
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  ciphertext[0] ^= 1;
  record.ciphertext = ciphertext.toString('base64');
  storage.values.set(VAULT_STORAGE_KEY, JSON.stringify(record));
  await rejectsCode(vault.unlock(USERNAME, PASSWORD), 'unlock_failed');
  assert.equal(vault.configured, true);
});

test('string pairs are unambiguous and spaces, Unicode, and normalization differences are preserved', async () => {
  const { vault } = fixture();
  await vault.save('ab', 'cdefghijklmnop', TOKEN);
  await rejectsCode(vault.unlock('a', 'bcdefghijklmnop'), 'unlock_failed');
  await vault.save('  雪の庭 é  ', '  🌸雪 café lantern river  ', TOKEN);
  assert.equal(await vault.unlock('  雪の庭 é  ', '  🌸雪 café lantern river  '), TOKEN);
  await rejectsCode(vault.unlock('雪の庭 é', '  🌸雪 café lantern river  '), 'unlock_failed');
  await rejectsCode(vault.unlock('  雪の庭 e\u0301  ', '  🌸雪 café lantern river  '), 'unlock_failed');
  await rejectsCode(vault.unlock('  雪の庭 é  ', '  🌸雪 café lantern river'), 'unlock_failed');
  await vault.save('\ud800', 'twelve string chars', TOKEN);
  assert.equal(await vault.unlock('\ud800', 'twelve string chars'), TOKEN);
  await rejectsCode(vault.unlock('\ufffd', 'twelve string chars'), 'unlock_failed');
});

test('credential bounds count code points and do not trim either secret string', async () => {
  const { vault, storage } = fixture();
  for (const [username, password] of [['', PASSWORD], [USERNAME, 'a'.repeat(11)],
    ['a'.repeat(257), PASSWORD], [USERNAME, 'a'.repeat(1025)], [USERNAME, '🌸'.repeat(6)],
    [null, PASSWORD], [USERNAME, { toString: () => PASSWORD }]]) {
    await rejectsCode(vault.save(username, password, TOKEN), 'invalid_credentials');
  }
  assert.equal(storage.writes.length, 0);
  await vault.save(' ', ' '.repeat(12), TOKEN);
  assert.equal(await vault.unlock(' ', ' '.repeat(12)), TOKEN);
  await vault.save('🌸'.repeat(256), '雪'.repeat(1024), TOKEN);
  assert.equal(await vault.unlock('🌸'.repeat(256), '雪'.repeat(1024)), TOKEN);
  await vault.save(USERNAME, '🌸'.repeat(12), TOKEN);
  assert.equal(await vault.unlock(USERNAME, '🌸'.repeat(12)), TOKEN);
});

test('token input accepts only a bounded fine-grained PAT and rejects whitespace/newline suffixes', async () => {
  const { cryptoImpl, calls } = instrumentCrypto();
  const { vault, storage } = fixture({ cryptoImpl });
  for (const token of ['', 'github_pat_', 'ghp_classic_fixture', 'ghu_user_fixture', ` ${TOKEN}`, `${TOKEN} `,
    `${TOKEN}\n`, `${TOKEN}\r`, `${TOKEN}\r\n`, `${TOKEN}\u2028`, `${TOKEN}é`, 'github_pat_' + 'a'.repeat(502), null]) {
    await rejectsCode(vault.save(USERNAME, PASSWORD, token), 'invalid_token');
  }
  assert.equal(calls.derivations.length, 0);
  assert.equal(storage.writes.length, 0);
  const maximum = 'github_pat_' + 'a'.repeat(501);
  assert.equal(maximum.length, 512);
  await vault.save(USERNAME, PASSWORD, maximum);
  assert.equal(await vault.unlock(USERNAME, PASSWORD), maximum);
});

test('strict record validation rejects malformed metadata and oversized values before any key derivation', async t => {
  const { vault, storage } = fixture();
  await vault.save(USERNAME, PASSWORD, TOKEN);
  const valid = JSON.parse(storage.values.get(VAULT_STORAGE_KEY));
  const variants = [
    'not-json', 'x'.repeat(2049), 'null', '[]', JSON.stringify({ ...valid, extra: 'unknown' }),
    JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, repository: 'budhi-halim/sakura-yuki' }),
    JSON.stringify({ ...valid, kdf: 'PBKDF2' }), JSON.stringify({ ...valid, iterations: 1 }),
    JSON.stringify({ ...valid, iterations: Number.MAX_SAFE_INTEGER }), JSON.stringify({ ...valid, iterations: '600000' }),
    JSON.stringify({ ...valid, cipher: 'AES-CBC' }), JSON.stringify({ ...valid, salt: 'AAAA' }),
    JSON.stringify({ ...valid, salt: Buffer.alloc(17).toString('base64') }),
    JSON.stringify({ ...valid, iv: Buffer.alloc(13).toString('base64') }),
    JSON.stringify({ ...valid, ciphertext: 'AAAA' }),
    JSON.stringify({ ...valid, ciphertext: Buffer.alloc(529).toString('base64') }),
    JSON.stringify({ ...valid, ciphertext: valid.ciphertext + '\n' }),
    JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'iv'))),
  ];
  for (let index = 0; index < variants.length; index += 1) await t.test(String(index), async () => {
    const { cryptoImpl, calls } = instrumentCrypto();
    const next = new CredentialVault({ storage, cryptoImpl });
    storage.values.set(VAULT_STORAGE_KEY, variants[index]);
    await rejectsCode(next.load(), 'vault_corrupt');
    await rejectsCode(next.unlock(USERNAME, PASSWORD), 'vault_corrupt');
    assert.equal(next.configured, false);
    assert.equal(next.available, true);
    assert.equal(calls.imports.length, 0);
    assert.equal(calls.derivations.length, 0);
  });
});

test('AES-GCM authenticates its domain context, IV, and salt', async () => {
  const changedAAD = instrumentCrypto({ encrypt: args => webcrypto.subtle.encrypt(
    { ...args[0], additionalData: new TextEncoder().encode('another app or purpose') }, args[1], args[2]) });
  const { vault, storage } = fixture({ cryptoImpl: changedAAD.cryptoImpl });
  await vault.save(USERNAME, PASSWORD, TOKEN);
  await rejectsCode(vault.unlock(USERNAME, PASSWORD), 'unlock_failed');
  const normal = new CredentialVault({ storage, cryptoImpl: webcrypto });
  await normal.save(USERNAME, PASSWORD, TOKEN);
  const initial = storage.values.get(VAULT_STORAGE_KEY);
  for (const field of ['salt', 'iv']) {
    const changed = JSON.parse(initial);
    const bytes = Buffer.from(changed[field], 'base64');
    bytes[0] ^= 1;
    changed[field] = bytes.toString('base64');
    storage.values.set(VAULT_STORAGE_KEY, JSON.stringify(changed));
    await rejectsCode(normal.unlock(USERNAME, PASSWORD), 'unlock_failed');
  }
});

test('unavailable storage and crypto are distinguishable and never expose adapter exceptions', async () => {
  const storage = new MemoryStorage();
  storage.failure = 'read';
  const vault = new CredentialVault({ storage, cryptoImpl: webcrypto });
  await rejectsCode(vault.load(), 'storage_unavailable');
  assert.equal(vault.available, false);
  storage.failure = null;
  assert.deepEqual(await vault.load(), { configured: false, available: true });
  const noCrypto = new CredentialVault({ storage, cryptoImpl: null });
  await rejectsCode(noCrypto.load(), 'crypto_unavailable');
  assert.equal(noCrypto.available, false);
  assert.doesNotThrow(() => noCrypto.forget(), 'Forget must not require cryptography');
  const invalid = [null, {}, { getItem() {}, setItem() {} },
    { get getItem() { throw new Error(TOKEN); } }];
  for (const item of invalid) {
    const unavailable = new CredentialVault({ storage: item, cryptoImpl: webcrypto });
    assert.equal(unavailable.available, false);
    await rejectsCode(unavailable.load(), 'storage_unavailable');
  }
  const unexpectedRead = new CredentialVault({ storage: {
    getItem: () => Promise.resolve(null), setItem() {}, removeItem() {},
  }, cryptoImpl: webcrypto });
  await rejectsCode(unexpectedRead.load(), 'storage_unavailable');
});

test('a throwing default localStorage getter is contained by the constructor', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error(TOKEN); } });
    const vault = new CredentialVault({ cryptoImpl: webcrypto });
    assert.equal(vault.available, false);
    await rejectsCode(vault.load(), 'storage_unavailable');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('failed writes, no-op storage, and failed forgetting report failure without false configured success', async () => {
  const { vault, storage } = fixture();
  storage.failure = 'write';
  await rejectsCode(vault.save(USERNAME, PASSWORD, TOKEN), 'storage_unavailable');
  assert.equal(vault.configured, false);
  assert.equal(storage.values.has(VAULT_STORAGE_KEY), false);
  storage.failure = null;
  await vault.save(USERNAME, PASSWORD, TOKEN);
  const stored = storage.values.get(VAULT_STORAGE_KEY);
  storage.failure = 'remove';
  assert.throws(() => vault.forget(), error => error instanceof CredentialVaultError && error.code === 'storage_unavailable');
  assert.equal(storage.values.get(VAULT_STORAGE_KEY), stored);
  assert.equal(vault.configured, true);
  storage.failure = null;
  assert.equal(vault.forget(), undefined);
  assert.equal(vault.configured, false);
  assert.equal(storage.values.has(VAULT_STORAGE_KEY), false);
  await rejectsCode(vault.unlock(USERNAME, PASSWORD), 'not_configured');
  const noop = new CredentialVault({ storage: { getItem: () => null, setItem() {}, removeItem() {} }, cryptoImpl: webcrypto });
  await rejectsCode(noop.save(USERNAME, PASSWORD, TOKEN), 'storage_unavailable');
  assert.equal(noop.configured, false);
});

test('cancelling or forgetting during encryption prevents every pending storage write', async t => {
  for (const action of ['cancel', 'forget']) await t.test(action, async () => {
    const entered = deferred();
    const release = deferred();
    const { cryptoImpl } = instrumentCrypto({ encrypt: async args => {
      const result = await webcrypto.subtle.encrypt(...args);
      entered.resolve();
      await release.promise;
      return result;
    } });
    const { vault, storage } = fixture({ cryptoImpl });
    const saving = vault.save(USERNAME, PASSWORD, TOKEN);
    const rejected = rejectsCode(saving, 'cancelled');
    await entered.promise;
    vault[action]();
    release.resolve();
    await rejected;
    assert.equal(storage.writes.length, 0);
    assert.equal(vault.configured, false);
    assert.equal(vault.error, null, 'A stale operation cannot overwrite newer state');
  });
});

test('cancelling or forgetting during decryption prevents a pending token return', async t => {
  for (const action of ['cancel', 'forget']) await t.test(action, async () => {
    const entered = deferred();
    const release = deferred();
    let decrypted;
    const { cryptoImpl } = instrumentCrypto({ decrypt: async args => {
      decrypted = await webcrypto.subtle.decrypt(...args);
      entered.resolve();
      await release.promise;
      return decrypted;
    } });
    const { vault, storage } = fixture({ cryptoImpl });
    await vault.save(USERNAME, PASSWORD, TOKEN);
    const unlocking = vault.unlock(USERNAME, PASSWORD);
    const rejected = rejectsCode(unlocking, 'cancelled');
    await entered.promise;
    vault[action]();
    release.resolve();
    await rejected;
    assert.ok(new Uint8Array(decrypted).every(byte => byte === 0));
    assert.equal(vault.configured, action === 'cancel');
    assert.equal(storage.values.has(VAULT_STORAGE_KEY), action === 'cancel');
    assert.equal(vault.error, null);
  });
});

test('a later operation supersedes a pending save and an external storage change blocks stale results', async () => {
  const entered = deferred();
  const release = deferred();
  const { cryptoImpl } = instrumentCrypto({ deriveKey: async key => {
    entered.resolve();
    await release.promise;
    return key;
  } });
  const { vault, storage } = fixture({ cryptoImpl });
  const saving = vault.save(USERNAME, PASSWORD, TOKEN);
  const rejected = rejectsCode(saving, 'cancelled');
  await entered.promise;
  assert.deepEqual(await vault.load(), { configured: false, available: true });
  release.resolve();
  await rejected;
  assert.equal(storage.writes.length, 0);

  const decryptEntered = deferred();
  const decryptRelease = deferred();
  const changed = instrumentCrypto({ decrypt: async args => {
    const plaintext = await webcrypto.subtle.decrypt(...args);
    decryptEntered.resolve();
    await decryptRelease.promise;
    return plaintext;
  } });
  const normal = new CredentialVault({ storage, cryptoImpl: changed.cryptoImpl });
  await normal.save(USERNAME, PASSWORD, TOKEN);
  const unlocking = normal.unlock(USERNAME, PASSWORD);
  const changedRejection = rejectsCode(unlocking, 'storage_changed');
  await decryptEntered.promise;
  storage.values.delete(VAULT_STORAGE_KEY);
  decryptRelease.resolve();
  await changedRejection;
});

test('external removal during a replacement save does not recreate the forgotten record', async () => {
  const storage = new MemoryStorage();
  const original = new CredentialVault({ storage, cryptoImpl: webcrypto });
  await original.save(USERNAME, PASSWORD, TOKEN);
  const entered = deferred();
  const release = deferred();
  const { cryptoImpl } = instrumentCrypto({ encrypt: async args => {
    const result = await webcrypto.subtle.encrypt(...args);
    entered.resolve();
    await release.promise;
    return result;
  } });
  const replacement = new CredentialVault({ storage, cryptoImpl });
  const saving = replacement.save(USERNAME, `${PASSWORD} new`, TOKEN);
  const rejected = rejectsCode(saving, 'storage_changed');
  await entered.promise;
  original.forget();
  release.resolve();
  await rejected;
  assert.equal(storage.values.has(VAULT_STORAGE_KEY), false);
  assert.equal(storage.writes.length, 1);
});

test('unexpected cryptographic failures and modified error objects never expose supplied inputs', async () => {
  const error = new CredentialVaultError('crypto_failed');
  error.message = `${TOKEN} ${PASSWORD}`;
  error.cause = new Error(USERNAME);
  const { cryptoImpl } = instrumentCrypto({ importKey() { throw error; } });
  const { vault } = fixture({ cryptoImpl });
  await rejectsCode(vault.save(USERNAME, PASSWORD, TOKEN), 'crypto_failed');
  assert.ok(!vault.error.message.includes(TOKEN));
  assert.equal(vault.error.cause, undefined);
  const untrusted = new CredentialVaultError(TOKEN);
  assert.equal(untrusted.code, 'crypto_failed');
  assert.ok(!untrusted.message.includes(TOKEN));
});
