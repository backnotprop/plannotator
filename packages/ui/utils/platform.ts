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
export const isWindows = typeof navigator !== 'undefined' && /^Win/.test(navigator.platform);
