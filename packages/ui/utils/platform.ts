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
 * The primary modifier as a screen reader should say it in a sentence
 * ("hold Command and scroll"), for live-region text.
 */
export const modKeySpoken = isMac ? 'Command' : 'Control';
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

/** What `rootPlatform` reads off `navigator` (User-Agent Client Hints are Chromium-only). */
export interface RootPlatformNavigator {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string } | null;
}

export type RootPlatform = 'apple' | 'windows' | 'android' | 'chromeos' | 'linux' | 'other';

/**
 * The operating system, coarse: what the page's CSS may need to know. Android
 * and ChromeOS are told apart from desktop Linux (their user agents say
 * "Linux" too); iPadOS in desktop mode says "Macintosh" and counts as apple.
 */
export function rootPlatform(nav: RootPlatformNavigator | undefined | null): RootPlatform {
  if (!nav) return 'other';
  const s = `${nav.userAgentData?.platform ?? ''} ${nav.platform ?? ''} ${nav.userAgent ?? ''}`;
  if (/Android/i.test(s)) return 'android';
  if (/CrOS|Chrome OS/i.test(s)) return 'chromeos';
  if (/Mac|iPhone|iPad|iPod/i.test(s)) return 'apple';
  if (/Win/i.test(s)) return 'windows';
  if (/Linux|X11|BSD/i.test(s)) return 'linux';
  return 'other';
}

/**
 * Put `pn-os-<platform>` on <html>, once. theme.css scopes platform-specific
 * rules to it: on desktop Linux the monospace fallback (Ubuntu Mono) draws
 * `ss02` as superscript digits, so only there are Inter's feature tags kept
 * off other fonts (#1961). ThemeProvider calls this synchronously in render,
 * with the theme classes, so the class is on the root before the first paint.
 * The marketing site and the guides.show landing page set the same class
 * from an inline script (keep their patterns in step with this one).
 */
export function markRootPlatform(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): void {
  if (!doc) return;
  const root = doc.documentElement;
  for (const cls of Array.from(root.classList)) if (cls.startsWith('pn-os-')) return;
  root.classList.add(`pn-os-${rootPlatform(typeof navigator !== 'undefined' ? navigator : null)}`);
}
