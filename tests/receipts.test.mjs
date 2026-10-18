import test from 'node:test';
import assert from 'node:assert/strict';
import { publicReceipt, readReceipts, writeReceipts } from '../assets/receipts.mjs';

const receipt = { requestId: 'batch-1', blobSha: 'a'.repeat(40), digest: 'b'.repeat(64), createdAt: '2026-10-18T00:00:00Z', state: 'submitting', token: 'SECRET', rawJson: 'PRIVATE PROMPT' };
test('persisted receipts exclude credentials and payloads by construction', () => {
  let saved;
  assert.equal(writeReceipts({ setItem: (_, value) => { saved = value; } }, [receipt]), true);
  assert.ok(!saved.includes('SECRET'));
  assert.ok(!saved.includes('PRIVATE PROMPT'));
  assert.equal(publicReceipt(receipt).requestId, 'batch-1');
});
test('interrupted submission recovers as unknown and does not claim safe acceptance', () => {
  const restored = readReceipts({ getItem: () => JSON.stringify([receipt]) });
  assert.equal(restored[0].state, 'unknown');
  assert.equal(restored[0].safe, false);
  assert.equal(restored[0].terminal, false);
});
test('corrupt or disabled browser storage cannot prevent operation', () => {
  assert.deepEqual(readReceipts({ getItem: () => '{bad' }), []);
  assert.deepEqual(readReceipts({ getItem: () => JSON.stringify([{ ...receipt, requestId: '../evil' }]) }), []);
  assert.equal(writeReceipts({ setItem: () => { throw new Error('unavailable'); } }, [receipt]), false);
});
