const TYPING_TARGETS = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const DOUBLE_Q_MS = 350;
const NAVIGATION_KEYS = new Set(['a', 'd', 'w', 's']);
const SHORTCUT_KEYS = new Set([...NAVIGATION_KEYS, 'q', 'e']);

function eventKey(event) {
  return typeof event.key === 'string' ? event.key.toLowerCase() : '';
}

/** Return a valid index after moving in a circular collection; empty lists use 0. */
export function wrapIndex(index, delta, length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  const current = Number.isFinite(index) ? Math.trunc(index) : 0;
  const movement = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (((current % length) + (movement % length)) % length + length) % length;
}

function isTypingTarget(target) {
  if (!target) return false;
  const element = typeof target.closest === 'function' ? target : target.parentElement;
  return Boolean(element?.isContentEditable || element?.closest?.(TYPING_TARGETS));
}

/**
 * Create a DOM-independent keyboard controller.
 *
 * Copy callbacks run synchronously inside handle(), retaining the keyboard
 * event's clipboard activation. The first Q copies the numbered title; a
 * second distinct Q within 350 ms replaces it with the unnumbered title.
 * Navigation follows the operating system's key-repeat delay and speed. There
 * are no movement timers: only keydown events can change the selection.
 *
 * Wire handle() to keydown and release() to keyup. Call reset() on blur, hidden
 * page, focus/pointer changes, or opening a dialog. When re-rendering a selection,
 * call resetCopyGesture() instead so the active navigation hold can continue.
 */
export function createShortcutHandler({
  getContext,
  onTheme,
  onVariation,
  onCopyTheme,
  onCopyPrompt,
  now = () => performance.now(),
}) {
  let pendingQ = null;
  const pressedKeys = new Set();

  function resetCopyGesture() {
    pendingQ = null;
  }

  function reset() {
    resetCopyGesture();
    pressedKeys.clear();
  }

  function release(event) {
    // Always process release, even if focus moved to a field or dialog meanwhile.
    // Do not prevent default or clear the Q gesture: the second Q needs keyup.
    return pressedKeys.delete(eventKey(event));
  }

  function handle(event) {
    const context = getContext();
    if (!context?.enabled) {
      reset();
      return false;
    }
    if (pendingQ && pendingQ.themeId !== context.themeId) resetCopyGesture();

    const originalTarget = event.composedPath?.()[0];
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || isTypingTarget(event.target) || isTypingTarget(originalTarget)) {
      reset();
      return false;
    }
    const key = eventKey(event);
    if (key !== 'q') resetCopyGesture();
    if (!SHORTCUT_KEYS.has(key)) return false;

    if (event.repeat) {
      // A hold that started in a field, another tab, or a disabled view must not
      // begin navigating merely because focus returns to the prompt reader.
      if (!NAVIGATION_KEYS.has(key) || !pressedKeys.has(key)) return false;
    } else {
      // Distinct copy strokes require a release; holding Q/E never spams writes.
      if (pressedKeys.has(key)) return false;
      pressedKeys.add(key);
    }

    event.preventDefault();
    switch (key) {
      case 'a':
        onTheme(-1);
        break;
      case 'd':
        onTheme(1);
        break;
      case 'w':
        onVariation(-1);
        break;
      case 's':
        onVariation(1);
        break;
      case 'q': {
        const timestamp = now();
        const elapsed = pendingQ ? timestamp - pendingQ.at : Infinity;
        const isDouble = elapsed >= 0 && elapsed <= DOUBLE_Q_MS;
        onCopyTheme(!isDouble);
        // The clipboard fallback briefly focuses a textarea. Preserve this Q
        // gesture after that synchronous focus/reset sequence completes.
        pendingQ = isDouble ? null : { at: timestamp, themeId: context.themeId };
        break;
      }
      case 'e':
        onCopyPrompt();
        break;
    }
    return true;
  }

  return { handle, release, reset, resetCopyGesture };
}
