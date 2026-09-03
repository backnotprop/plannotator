/**
 * Platform detection for keyboard shortcut hints.
 *
 * Canonical source — import from here instead of inlining navigator checks.
 * Used across the plan editor, code review, and shared UI components.
 */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
export const altKey = isMac ? '⌥' : 'Alt';
export const submitHint = isMac ? '⌘↵' : 'Ctrl+Enter';
/**
 * The primary modifier spelled for PROSE ("Cmd+click"), where `modKey`'s ⌘
 * glyph reads as an artifact rather than a word. Use this in sentences;
 * use `modKey` in key hints and shortcut chips.
 */
export const modKeyWord = isMac ? 'Cmd' : 'Ctrl';
/**
 * The primary modifier's own `KeyboardEvent.key` name, for features that arm
 * on the modifier being HELD rather than on a chord. Pair with `isModKeyHeld`:
 * this identifies the key itself, that reads the held flag off any event.
 */
export const modEventKey = isMac ? 'Meta' : 'Control';
/** Whether the primary modifier is down for this event, on this platform. */
export function isModKeyHeld(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
export const isWindows = typeof navigator !== 'undefined' && /^Win/.test(navigator.platform);
