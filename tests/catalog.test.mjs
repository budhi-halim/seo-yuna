import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CatalogError, MAX_IMPORT_BYTES, parseCatalog, validateCatalog, mergeCatalog,
} from '../assets/catalog.mjs';

function variation(id = 'first-prompt', name = 'First prompt', prompt = 'Original prompt.\nKeep all spacing.  ') {
  return { id, name, prompt };
}

function theme(id = 'first-theme', name = 'First theme', variations = [variation()]) {
  return { id, name, variations };
}

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

test('the retained catalog validates without imposing eight variations per theme', async () => {
  const current = JSON.parse(await readFile(new URL('../data.json', import.meta.url), 'utf8'));
  assert.equal(validateCatalog(current), current);
  const result = mergeCatalog(current, current);
  assert.equal(result.changed, false);
  assert.equal(result.duplicateVariations, current.reduce((sum, item) => sum + item.variations.length, 0));
});

test('UTF-8 JSON, a leading BOM, whitespace and prompt contents survive unchanged', () => {
  const current = [theme('cafe-theme', 'Café 東京', [variation('unicode-prompt', 'Été 🌷', '  Café.\n東京 🌷\t  ')])];
  assert.deepEqual(parseCatalog('\uFEFF' + JSON.stringify(current)), current);
  assert.equal(validateCatalog(current), current);
});

test('empty arrays are valid and identical content produces a no-op', () => {
  assert.deepEqual(parseCatalog('[]'), []);
  assert.equal(mergeCatalog([], []).changed, false);
  assert.equal(validateCatalog([theme('empty-theme', 'An empty theme', [])]).length, 1);
});

test('the 5 MiB upload cap measures UTF-8 bytes before JSON parsing', () => {
  assert.throws(() => parseCatalog(' '.repeat(MAX_IMPORT_BYTES + 1)), { code: 'import_too_large' });
  assert.throws(() => parseCatalog('🌷'.repeat(Math.floor(MAX_IMPORT_BYTES / 4) + 1)), { code: 'import_too_large' });
  assert.throws(() => parseCatalog('{secret-looking malformed text'), (error) =>
    error instanceof CatalogError && error.code === 'invalid_json' && !error.message.includes('secret-looking'));
});

test('strict shape, exact fields, slugs and text limits are enforced', async (t) => {
  const invalid = [
    ['null root', null],
    ['object root', {}],
    ['null theme', [null]],
    ['array theme', [[]]],
    ['missing field', [{ id: 'missing', name: 'Missing variations' }]],
    ['unknown field', [{ ...theme(), extra: true }]],
    ['null variations', [theme('a', 'A', null)]],
    ['null variation', [theme('a', 'A', [null])]],
    ['array variation', [theme('a', 'A', [[]])]],
    ['missing prompt', [theme('a', 'A', [{ id: 'a', name: 'A' }])]],
    ['unknown variation field', [theme('a', 'A', [{ ...variation(), html: '<b>' }])]],
    ['uppercase ID', [theme('Bad-Id')]],
    ['underscore ID', [theme('bad_id')]],
    ['repeated hyphen ID', [theme('bad--id')]],
    ['leading hyphen ID', [theme('-bad')]],
    ['oversized ID', [theme('a'.repeat(161))]],
    ['blank name', [theme('a', '\n\t ')]],
    ['numeric name', [theme('a', 42)]],
    ['oversized name', [theme('a', 'n'.repeat(241))]],
    ['blank prompt', [theme('a', 'A', [variation('p', 'P', ' \n ')])]],
    ['oversized prompt', [theme('a', 'A', [variation('p', 'P', 'p'.repeat(40_001))])]],
    ['sparse theme array', new Array(1)],
    ['sparse variation array', [theme('a', 'A', new Array(1))]],
  ];
  for (const [label, value] of invalid) {
    await t.test(label, () => assert.throws(() => validateCatalog(value), CatalogError));
  }
  assert.doesNotThrow(() => validateCatalog([
    theme('a'.repeat(160), 'n'.repeat(240), [variation('p', 'n'.repeat(240), 'p'.repeat(40_000))]),
  ]));
});

test('duplicate IDs within one upload are rejected, including identical duplicates', () => {
  assert.throws(() => validateCatalog([theme(), theme()]), { code: 'duplicate_theme_id' });
  assert.throws(() => validateCatalog([theme('a', 'A', [variation(), variation()])]), { code: 'duplicate_variation_id' });
  assert.throws(() => validateCatalog([theme(), theme('second-theme', 'Second theme')]), { code: 'duplicate_variation_id' });
});

test('append merge preserves theme order and variation order with accurate statistics', () => {
  const current = frozen([
    theme('one', 'One', [variation('first', 'First')]),
    theme('two', 'Two', [variation('second', 'Second')]),
  ]);
  const incoming = frozen([
    theme('two', 'Two', [variation('second', 'Second'), variation('third', 'Third')]),
    theme('new', 'New', [variation('fourth', 'Fourth')]),
    theme('last', 'Last', [variation('fifth', 'Fifth')]),
  ]);
  const result = mergeCatalog(current, incoming);
  assert.deepEqual(result.catalog.map((item) => item.id), ['one', 'two', 'new', 'last']);
  assert.deepEqual(result.catalog[1].variations.map((item) => item.id), ['second', 'third']);
  assert.equal(result.addedThemes, 2);
  assert.equal(result.addedVariations, 3);
  assert.equal(result.duplicateVariations, 1);
  assert.equal(result.extendedThemes, 1);
  assert.equal(result.changed, true);
  assert.notEqual(result.catalog[0], current[0]);
  assert.notEqual(result.catalog[0].variations[0], current[0].variations[0]);
  assert.notEqual(result.catalog[2], incoming[1]);
  assert.notEqual(result.catalog[2].variations[0], incoming[1].variations[0]);
  assert.equal(current[1].variations.length, 1);
  assert.equal(incoming[0].variations.length, 2);
});

test('newly appended objects do not retain mutable references to either input', () => {
  const current = [theme()];
  const incoming = [theme('new-theme', 'New theme', [variation('new-prompt', 'New prompt')])];
  const result = mergeCatalog(current, incoming);
  result.catalog[0].variations[0].prompt = 'Changed result';
  result.catalog[1].variations[0].prompt = 'Changed new result';
  assert.equal(current[0].variations[0].prompt, variation().prompt);
  assert.equal(incoming[0].variations[0].prompt, variation().prompt);
});

test('a late conflict rejects the entire batch without modifying either input', () => {
  const current = [theme()];
  const incoming = [
    theme('new-theme', 'New theme', [variation('new-prompt', 'New prompt')]),
    theme('first-theme', 'Changed theme name'),
  ];
  const beforeCurrent = JSON.stringify(current);
  const beforeIncoming = JSON.stringify(incoming);
  assert.throws(() => mergeCatalog(current, incoming), { code: 'theme_conflict' });
  assert.equal(JSON.stringify(current), beforeCurrent);
  assert.equal(JSON.stringify(incoming), beforeIncoming);
});

test('existing theme names, variation names and prompts cannot be overwritten', () => {
  const current = [theme()];
  assert.throws(() => mergeCatalog(current, [theme('first-theme', 'Changed')]), { code: 'theme_conflict' });
  assert.throws(() => mergeCatalog(current, [theme('first-theme', 'First theme', [variation('first-prompt', 'Changed')])]),
    { code: 'variation_conflict' });
  assert.throws(() => mergeCatalog(current, [theme('first-theme', 'First theme', [variation('first-prompt', 'First prompt', 'Changed')])]),
    { code: 'variation_conflict' });
});

test('a variation ID cannot move to another theme even if its content is identical', () => {
  assert.throws(() => mergeCatalog([theme()], [theme('new-theme', 'New theme')]),
    { code: 'variation_theme_conflict' });
});

test('HTML, shell fragments and JavaScript strings remain inert data', () => {
  const payload = '<img src=x onerror=alert(1)>; $(touch injected); </script>; ' + String.fromCharCode(96) + 'process.exit(7)';
  const incoming = [theme('constructor', payload, [variation('prototype', payload, payload)])];
  const result = mergeCatalog([], parseCatalog(JSON.stringify(incoming)));
  assert.deepEqual(result.catalog, incoming);
  assert.equal({}.polluted, undefined);
  const unknown = JSON.parse('[{"id":"a","name":"A","variations":[],"__proto__":{"polluted":true}}]');
  assert.throws(() => validateCatalog(unknown), { code: 'unknown_field' });
});

test('accessor fields are refused before they can execute', () => {
  let calls = 0;
  const item = theme();
  Object.defineProperty(item, 'name', { get() { calls += 1; return 'bad'; }, enumerable: true });
  assert.throws(() => validateCatalog([item]), CatalogError);
  assert.equal(calls, 0);
});
