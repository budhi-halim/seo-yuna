import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutHandler, wrapIndex } from '../assets/shortcuts.mjs';

const nonEditable = { closest: () => null };

function setup(overrides = {}) {
  let clock = 0;
  const context = { enabled: true, themeId: 'first-theme' };
  const calls = [];
  const handler = createShortcutHandler({
    getContext: () => context,
    onTheme: (delta) => calls.push(['theme', delta]),
    onVariation: (delta) => calls.push(['variation', delta]),
    onCopyTheme: (withNumber) => calls.push(['copyTheme', withNumber]),
    onCopyPrompt: () => calls.push(['copyPrompt']),
    now: () => clock,
    ...overrides,
  });
  function press(key, properties = {}) {
    let prevented = false;
    const event = {
      key,
      target: nonEditable,
      preventDefault() { prevented = true; },
      ...properties,
    };
    const handled = handler.handle(event);
    return { handled, prevented };
  }
  return { context, calls, handler, press, advance: (ms) => { clock += ms; } };
}

test('circular navigation wraps at the ends and across multiple cycles', () => {
  assert.equal(wrapIndex(0, -1, 22), 21);
  assert.equal(wrapIndex(21, 1, 22), 0);
  assert.equal(wrapIndex(2, -15, 4), 3);
  assert.equal(wrapIndex(3, 18, 8), 5);
  assert.equal(wrapIndex(0, -1, 1), 0);
  assert.equal(wrapIndex(0, 1, 0), 0);
  assert.equal(wrapIndex(5, -1, -2), 0);
  assert.equal(wrapIndex(5, 1, NaN), 0);
});

test('navigation uses the current theme variation count, including legacy four-variation themes', () => {
  const sizes = [4, 8];
  let theme = 0;
  let variation = 0;
  const state = setup({
    onTheme(delta) {
      theme = wrapIndex(theme, delta, sizes.length);
      variation = wrapIndex(variation, 0, sizes[theme]);
    },
    onVariation(delta) { variation = wrapIndex(variation, delta, sizes[theme]); },
  });
  state.press('w');
  assert.equal(variation, 3);
  state.press('s');
  assert.equal(variation, 0);
  state.press('a');
  assert.equal(theme, 1);
  state.press('w');
  assert.equal(variation, 7);
  state.press('d');
  assert.equal(theme, 0);
  assert.equal(variation, 3);
  state.press('s');
  assert.equal(variation, 0);
});

test('A/D, W/S, and E call the correct action and prevent default', () => {
  const state = setup();
  for (const key of ['a', 'd', 'w', 's', 'e']) {
    assert.deepEqual(state.press(key), { handled: true, prevented: true });
  }
  assert.deepEqual(state.calls, [
    ['theme', -1], ['theme', 1], ['variation', -1], ['variation', 1], ['copyPrompt'],
  ]);
  assert.deepEqual(state.press('x'), { handled: false, prevented: false });
});

test('Shift-letter shortcuts work without capturing browser modifier shortcuts', () => {
  const state = setup();
  state.press('D', { shiftKey: true });
  state.press('Q', { shiftKey: true });
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.deepEqual(state.press('a', { [modifier]: true }), { handled: false, prevented: false });
  }
  assert.deepEqual(state.calls, [['theme', 1], ['copyTheme', true]]);
});

test('first Q writes immediately; the second distinct Q replaces it without numbering', () => {
  const state = setup();
  state.press('q');
  // These assertions run in the same call stack: no timer or microtask is needed.
  assert.deepEqual(state.calls, [['copyTheme', true]]);
  state.advance(200);
  state.press('q');
  assert.deepEqual(state.calls, [['copyTheme', true], ['copyTheme', false]]);
  state.advance(10);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', true]);
});

test('Q pair expires after 350 ms and accepts the window boundary', () => {
  const state = setup();
  state.press('q');
  state.advance(350);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', false]);
  state.press('q');
  state.advance(351);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', true]);
});

test('key auto-repeat never navigates or turns a held Q into a double press', () => {
  const state = setup();
  state.press('q');
  state.advance(50);
  for (const key of ['q', 'a', 's', 'e']) {
    assert.deepEqual(state.press(key, { repeat: true }), { handled: false, prevented: false });
  }
  assert.deepEqual(state.calls, [['copyTheme', true]]);
  state.advance(50);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', false]);
});

test('intervening navigation or an unrelated key starts a new Q gesture', () => {
  for (const key of ['a', 's', 'e', 'x', 'Escape']) {
    const state = setup();
    state.press('q');
    state.advance(30);
    state.press(key);
    state.advance(30);
    state.press('q');
    assert.deepEqual(state.calls.at(-1), ['copyTheme', true], key);
  }
});

test('theme changes and explicit resets prevent copying an unrelated title without its number', () => {
  const state = setup();
  state.press('q');
  state.context.themeId = 'second-theme';
  state.advance(50);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', true]);
  state.handler.reset();
  state.advance(50);
  state.press('q');
  assert.deepEqual(state.calls.at(-1), ['copyTheme', true]);
});

test('typing controls and editable descendants retain every shortcut key', () => {
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]']) {
    const state = setup();
    const target = {
      closest(query) {
        assert.ok(query.includes(selector));
        return this;
      },
    };
    for (const key of ['a', 'd', 'w', 's', 'q', 'e']) {
      assert.deepEqual(state.press(key, { target }), { handled: false, prevented: false });
    }
    assert.deepEqual(state.calls, []);
  }
});

test('editable text nodes, inherited editing, and shadow-root input targets are guarded', () => {
  const editable = { closest: () => ({}) };
  const targets = [
    { target: { parentElement: editable } },
    { target: { isContentEditable: true, closest: () => null } },
    { target: nonEditable, composedPath: () => [editable, nonEditable] },
  ];
  const state = setup();
  for (const properties of targets) {
    assert.deepEqual(state.press('q', properties), { handled: false, prevented: false });
  }
  assert.deepEqual(state.calls, []);
});

test('null targets are safe and noneditable content remains navigable', () => {
  const state = setup();
  assert.deepEqual(state.press('a', { target: null }), { handled: true, prevented: true });
  let guardedSelector;
  const target = { closest(query) { guardedSelector = query; return null; } };
  state.press('d', { target });
  assert.ok(guardedSelector.includes('[contenteditable]:not([contenteditable="false"])'));
  assert.deepEqual(state.calls, [['theme', -1], ['theme', 1]]);
});

test('composing, consumed, and modifier key events are ignored and cancel a pending Q pair', () => {
  for (const properties of [
    { isComposing: true }, { defaultPrevented: true }, { ctrlKey: true },
    { metaKey: true }, { altKey: true }, { target: { closest: () => ({}) } },
  ]) {
    const state = setup();
    state.press('q');
    state.advance(50);
    assert.deepEqual(state.press('q', properties), { handled: false, prevented: false });
    state.advance(50);
    state.press('q');
    assert.deepEqual(state.calls, [['copyTheme', true], ['copyTheme', true]]);
  }
});

test('disabled contexts do not handle keys and reset pending Q state', () => {
  const state = setup();
  state.press('q');
  state.context.enabled = false;
  state.advance(50);
  for (const key of ['a', 'd', 'w', 's', 'q', 'e']) {
    assert.deepEqual(state.press(key), { handled: false, prevented: false });
  }
  state.context.enabled = true;
  state.press('q');
  assert.deepEqual(state.calls, [['copyTheme', true], ['copyTheme', true]]);
});

test('malformed key events and a nonmonotonic test clock do not create accidental double-Q', () => {
  const state = setup();
  assert.deepEqual(state.press(undefined), { handled: false, prevented: false });
  state.advance(100);
  state.press('q');
  state.advance(-10);
  state.press('q');
  assert.deepEqual(state.calls, [['copyTheme', true], ['copyTheme', true]]);
});
