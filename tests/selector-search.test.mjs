import test from 'node:test';
import assert from 'node:assert/strict';
import { searchNumberedEntries } from '../assets/selector-search.mjs';
import { createShortcutHandler } from '../assets/shortcuts.mjs';

const entries = Array.from({ length: 12 }, (_, index) => ({
  id: `theme-${index + 1}`,
  name: index === 1 ? 'Quiet Garden' : index === 11 ? 'Ethereal Glacial Ice Cave' : `Studio scene ${index + 1}`,
}));

test('names, exact displayed numbers, and combined numbered titles share one search', () => {
  for (const query of ['glacial', 'ICE cave', '12', '12.', '12. Ethereal Glacial Ice Cave', '12 glacial cave', '  １２.   ETHEREAL  ']) {
    const result = searchNumberedEntries(entries, query, 'theme-12');
    assert.deepEqual(result.matches.map(choice => choice.label), ['12. Ethereal Glacial Ice Cave'], query);
    assert.equal(result.matches[0].index, 11);
    assert.equal(result.retained, null);
  }
  assert.deepEqual(searchNumberedEntries(entries, '2', 'theme-2').matches.map(choice => choice.id), ['theme-2']);
  assert.deepEqual(searchNumberedEntries(entries, '2 ice', 'theme-2').matches, []);
});

test('filtering retains the actual selection outside the matches and never renumbers results', () => {
  const result = searchNumberedEntries(entries, 'ice', 'theme-2');
  assert.deepEqual(result.retained, { id: 'theme-2', index: 1, label: '2. Quiet Garden' });
  assert.deepEqual(result.matches, [{ id: 'theme-12', index: 11, label: '12. Ethereal Glacial Ice Cave' }]);
  const noMatches = searchNumberedEntries(entries, 'unlisted name', 'theme-2');
  assert.deepEqual(noMatches.matches, []);
  assert.equal(noMatches.retained.id, 'theme-2');
  // A/D can move through the full catalog while the filter stays active.
  assert.equal(searchNumberedEntries(entries, 'ice', 'theme-3').retained.id, 'theme-3');
  assert.equal(entries[1].id, 'theme-2');
  assert.equal(entries.length, 12);
});

test('variation numbering is local to its theme and clearing a filter restores every choice', () => {
  const variations = [{ id: 'variation-one', name: 'At the Window' }, { id: 'variation-two', name: 'Glacial Reflection' }];
  assert.deepEqual(searchNumberedEntries(variations, '2. reflection', 'variation-one').matches,
    [{ id: 'variation-two', index: 1, label: '2. Glacial Reflection' }]);
  const cleared = searchNumberedEntries(variations, '   ', 'variation-two');
  assert.equal(cleared.active, false);
  assert.equal(cleared.matches.length, 2);
  assert.equal(cleared.retained, null);
  assert.deepEqual(searchNumberedEntries([], '2', '').matches, []);
});

test('typing search queries does not run prompt shortcuts', () => {
  const fired = [];
  const shortcuts = createShortcutHandler({
    getContext: () => ({ enabled: true, themeId: 'theme-2' }),
    onTheme: value => fired.push(value), onVariation: value => fired.push(value),
    onCopyTheme: value => fired.push(value), onCopyPrompt: () => fired.push('copy'),
  });
  for (const key of ['a', 'd', 'w', 's', 'q', 'q', 'e']) {
    shortcuts.handle({ key, target: { tagName: 'INPUT', type: 'search', isContentEditable: false,
      closest: selector => selector.includes('input') ? {} : null }, preventDefault: () => assert.fail('search typing must keep its default action') });
  }
  assert.deepEqual(fired, []);
});
