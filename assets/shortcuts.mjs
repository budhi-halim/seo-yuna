const TYPING_TARGETS = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
const DOUBLE_Q_MS = 350;

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
 * Call reset() on window blur or when changing selections outside this handler.
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

  function reset() {
    pendingQ = null;
  }

  function handle(event) {
    const context = getContext();
    if (!context?.enabled) {
      reset();
      return false;
    }
    if (pendingQ && pendingQ.themeId !== context.themeId) reset();

    const originalTarget = event.composedPath?.()[0];
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
      || isTypingTarget(event.target) || isTypingTarget(originalTarget)) {
      reset();
      return false;
    }
    if (event.repeat) return false;

    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 'q') reset();
    if (!['a', 'd', 'w', 's', 'q', 'e'].includes(key)) return false;

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
        pendingQ = isDouble ? null : { at: timestamp, themeId: context.themeId };
        onCopyTheme(!isDouble);
        break;
      }
      case 'e':
        onCopyPrompt();
        break;
    }
    return true;
  }

  return { handle, reset };
}
