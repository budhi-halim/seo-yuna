import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMPORT_BYTES, parseCatalog } from '../assets/catalog.mjs';
import { ImportBatchError, sortFiles, buildFileBatch } from '../assets/import-batch.mjs';

const encoder = new TextEncoder();
const bytes = text => encoder.encode(text).byteLength;
const variation = (id, prompt = `Original prompt ${id}.\nKeep spacing.  `, name = `Variation ${id}`) => ({ id, name, prompt });
const theme = (id, variations = [variation(`${id}-one`)], name = `Theme ${id}`) => ({ id, name, variations });
const file = (name, catalog = [theme('first')]) => ({ name, text: JSON.stringify(catalog) });
const names = files => sortFiles(files).map(item => item.name);

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

test('filename sorting is numeric, deterministic, and does not mutate the selection', () => {
  const selected = frozen([file('data_10.json'), file('data_2.json'), file('data_1.json')]);
  const sorted = sortFiles(selected);
  assert.deepEqual(sorted.map(item => item.name), ['data_1.json', 'data_2.json', 'data_10.json']);
  assert.deepEqual(selected.map(item => item.name), ['data_10.json', 'data_2.json', 'data_1.json']);
  assert.equal(sorted[0], selected[2]);
  assert.notEqual(sorted, selected);
  assert.deepEqual(names(new Set([...selected].reverse())), sorted.map(item => item.name));
  assert.deepEqual(sortFiles([]), []);
});

test('zero padding and case use original lexical names only after a full natural tie', () => {
  const selected = ['data_1.json', 'data_01.json', 'data_001.json', 'data_0.json', 'data_000.json', 'data_2.json', 'DATA_2.json', 'data_02.json'];
  const expected = ['data_0.json', 'data_000.json', 'data_001.json', 'data_01.json', 'data_1.json', 'DATA_2.json', 'data_02.json', 'data_2.json'];
  assert.deepEqual(names(selected.map(name => ({ name }))), expected);
  assert.deepEqual(names([...selected].reverse().map(name => ({ name }))), expected);
  assert.deepEqual(names(['data_02b.json', 'data_2a.json'].map(name => ({ name }))), ['data_2a.json', 'data_02b.json']);
});

test('every numeric run and integers beyond Number precision sort correctly', () => {
  assert.deepEqual(names(['part_10_1.json', 'part_2_10.json', 'part_2_3.json'].map(name => ({ name }))),
    ['part_2_3.json', 'part_2_10.json', 'part_10_1.json']);
  assert.deepEqual(names(['data_9007199254740993.json', 'data_9007199254740992.json', 'data_100000000000000000000.json'].map(name => ({ name }))),
    ['data_9007199254740992.json', 'data_9007199254740993.json', 'data_100000000000000000000.json']);
});

test('malformed selections fail clearly and exact duplicate filenames are rejected', () => {
  for (const value of [undefined, null, 1, {}]) assert.throws(() => sortFiles(value), ImportBatchError);
  for (const value of [[null], [{}], [{ name: '' }], [{ name: 1 }]]) {
    assert.throws(() => sortFiles(value), { code: 'invalid_filename' });
  }
  assert.throws(() => buildFileBatch([]), /at least one JSON file/);
  assert.throws(() => buildFileBatch([file('same.json'), file('same.json', [theme('second')])]), error => {
    assert.equal(error.code, 'duplicate_filename');
    assert.equal(error.filename, 'same.json');
    assert.match(error.message, /same\.json/);
    return true;
  });
  assert.doesNotThrow(() => buildFileBatch([file('DATA_1.JSON'), file('data_1.json')]));
});

test('multiple files preserve first appearance of themes and variation order', () => {
  const selected = frozen([
    file('data_10.json', [theme('third'), theme('first', [variation('first-three')])]),
    file('data_2.json', [theme('second'), theme('first', [variation('first-two')])]),
    file('data_1.json', [theme('first'), theme('fourth')]),
  ]);
  const before = JSON.stringify(selected);
  const result = buildFileBatch(selected);
  assert.deepEqual(result.files.map(item => item.name), ['data_1.json', 'data_2.json', 'data_10.json']);
  assert.deepEqual(result.incoming.map(item => item.id), ['first', 'fourth', 'second', 'third']);
  assert.deepEqual(result.incoming[0].variations.map(item => item.id), ['first-one', 'first-two', 'first-three']);
  assert.deepEqual(JSON.parse(result.source), result.incoming);
  assert.deepEqual(parseCatalog(result.source), result.incoming);
  assert.equal(result.source, JSON.stringify(result.incoming));
  assert.equal(result.duplicateVariationsAcrossFiles, 0);
  assert.equal(JSON.stringify(selected), before);
  for (const summary of result.files) {
    const original = selected.find(item => item.name === summary.name);
    assert.deepEqual(summary, { name: original.name, bytes: bytes(original.text), themes: 2, variations: 2 });
  }
});

test('exact duplicates across files are skipped while summaries describe every source file', () => {
  const repeated = theme('first');
  const result = buildFileBatch([
    file('batch_3.json', [repeated, theme('second')]),
    file('batch_1.json', [repeated]),
    file('batch_2.json', [theme('first', [variation('first-one'), variation('first-two')])]),
  ]);
  assert.equal(result.duplicateVariationsAcrossFiles, 2);
  assert.deepEqual(result.incoming[0].variations.map(item => item.id), ['first-one', 'first-two']);
  assert.deepEqual(result.files.map(item => item.variations), [1, 2, 2]);
  assert.deepEqual(result.incoming.map(item => item.id), ['first', 'second']);
});

test('late theme, prompt, variation-name, and ownership conflicts reject atomically with filename context', () => {
  const conflicts = [
    [theme('first', [variation('first-one')], 'Changed theme')],
    [theme('first', [variation('first-one', 'Changed prompt')])],
    [theme('first', [variation('first-one', variation('first-one').prompt, 'Changed variation')])],
    [theme('other', [variation('first-one')])],
  ];
  for (const conflict of conflicts) {
    const selected = frozen([file('batch_1.json'), file('batch_2.json', [theme('new')]), file('batch_10.json', conflict)]);
    const before = JSON.stringify(selected);
    assert.throws(() => buildFileBatch(selected), error => {
      assert.ok(error instanceof ImportBatchError);
      assert.equal(error.filename, 'batch_10.json');
      assert.match(error.message, /batch_10\.json/);
      assert.ok(['theme_conflict', 'variation_conflict', 'variation_theme_conflict'].includes(error.code));
      assert.ok(error.path.startsWith('catalog[0]'));
      return true;
    });
    assert.equal(JSON.stringify(selected), before);
    assert.equal(buildFileBatch(selected.slice(0, 2)).incoming.length, 2);
  }
});

test('each file is independently strict, nonempty JSON with the .json extension', () => {
  const invalid = [
    [{ name: 'bad.txt', text: file('good.json').text }, 'invalid_extension'],
    [{ name: 'bad.json', text: '{bad' }, 'invalid_json'],
    [{ name: 'bad.json', text: null }, 'invalid_json'],
    [file('bad.json', []), 'empty_file'],
    [file('bad.json', [theme('empty', [])]), 'empty_file'],
    [file('bad.json', [theme('same'), theme('same')]), 'duplicate_theme_id'],
    [file('bad.json', [theme('same', [variation('same-one'), variation('same-one')])]), 'duplicate_variation_id'],
    [file('bad.json', [{ ...theme('bad'), unknown: 'field' }]), 'unknown_field'],
  ];
  for (const [badFile, code] of invalid) {
    assert.throws(() => buildFileBatch([file('a-good.json'), badFile]), error => {
      assert.equal(error.code, code);
      assert.equal(error.filename, badFile.name);
      assert.ok(error.message.includes(badFile.name));
      return true;
    });
  }
  const valid = buildFileBatch([file('mixed.json', [theme('empty', []), theme('useful')])]);
  assert.equal(valid.incoming.length, 2);
});

test('filenames and prompt HTML, Unicode, whitespace, and shell-like text remain inert and exact', () => {
  const name = '<img onerror=alert(1)>_1.json';
  const prompt = '  Café 東京 🌷\n<script>alert(1)</script>\t$(touch injected)  ';
  const selected = [{ name, text: '\uFEFF\n' + JSON.stringify([theme('unicode', [variation('unicode-one', prompt)])]) }];
  const result = buildFileBatch(selected);
  assert.equal(result.files[0].name, name);
  assert.equal(result.files[0].bytes, bytes(selected[0].text));
  assert.equal(result.incoming[0].variations[0].prompt, prompt);
  assert.equal(JSON.parse(result.source)[0].variations[0].prompt, prompt);
  const dangerousName = 'broken\n"<script>_2.json';
  assert.throws(() => buildFileBatch([{ name: dangerousName, text: 'invalid private input' }]), error => {
    assert.equal(error.filename, dangerousName);
    assert.ok(error.message.includes(JSON.stringify(dangerousName)));
    assert.ok(!error.message.includes('private input'));
    return true;
  });
});

test('the combined original-source limit includes BOM, whitespace, and duplicate files', () => {
  const first = file('a.json');
  first.text = '\uFEFF' + first.text;
  const second = file('b.json');
  second.text += ' '.repeat(MAX_IMPORT_BYTES - bytes(first.text) - bytes(second.text));
  assert.ok(bytes(first.text) < MAX_IMPORT_BYTES && bytes(second.text) < MAX_IMPORT_BYTES);
  const result = buildFileBatch([second, first]);
  assert.equal(result.files.reduce((sum, item) => sum + item.bytes, 0), MAX_IMPORT_BYTES);
  assert.equal(result.duplicateVariationsAcrossFiles, 1);
  assert.throws(() => buildFileBatch([first, { ...second, text: second.text + ' ' }]), error => {
    assert.equal(error.code, 'batch_too_large');
    assert.equal(error.filename, 'b.json');
    return true;
  });
});

test('individual source limits use parseCatalog and identify the oversized file', () => {
  const oversized = file('oversized.json');
  oversized.text += ' '.repeat(MAX_IMPORT_BYTES + 1 - bytes(oversized.text));
  assert.throws(() => buildFileBatch([file('a.json'), oversized]), { code: 'import_too_large', filename: 'oversized.json' });
});

test('the combined limit counts multibyte UTF-8 even when JavaScript lengths would fit', () => {
  const chunk = [theme('large', Array.from({ length: 25 }, (_, index) => variation(`large-${index}`, '東'.repeat(35_000))))];
  const first = file('one.json', chunk);
  const second = file('two.json', chunk);
  assert.ok(first.text.length + second.text.length < MAX_IMPORT_BYTES);
  assert.ok(bytes(first.text) < MAX_IMPORT_BYTES);
  assert.ok(bytes(first.text) + bytes(second.text) > MAX_IMPORT_BYTES);
  assert.throws(() => buildFileBatch([second, first]), { code: 'batch_too_large', filename: 'two.json' });
});

test('the exact serialized upload is capped independently of original text size', () => {
  // JSON.parse permits literal lone UTF-16 surrogates. JSON.stringify escapes
  // them, so a direct caller's text can expand even with compact serialization.
  const catalog = [theme('escaped', Array.from({ length: 35 }, (_, index) => variation(`escaped-${index}`, '\ud800'.repeat(40_000))))];
  const text = JSON.stringify(catalog).replaceAll('\\ud800', '\ud800');
  assert.ok(bytes(text) < MAX_IMPORT_BYTES);
  assert.ok(bytes(JSON.stringify(catalog)) > MAX_IMPORT_BYTES);
  assert.throws(() => buildFileBatch([{ name: 'escaped.json', text }]), { code: 'payload_too_large' });
});

test('paste stays one strict JSON array rather than implicitly concatenating documents', () => {
  const first = file('a.json', [theme('first')]);
  const second = file('b.json', [theme('second')]);
  assert.throws(() => parseCatalog(first.text + '\n' + second.text), { code: 'invalid_json' });
  assert.deepEqual(parseCatalog(first.text), [theme('first')]);
  assert.equal(buildFileBatch([second, first]).incoming.length, 2);
});
