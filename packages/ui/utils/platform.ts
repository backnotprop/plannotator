export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
export const altKey = isMac ? '⌥' : 'Alt';
export const submitHint = isMac ? '⌘↵' : 'Ctrl+Enter';
export const modKeyWord = isMac ? 'Cmd' : 'Ctrl';
export const modKeySpoken = isMac ? 'Command' : 'Control';
export const modEventKey = isMac ? 'Meta' : 'Control';
export function isModKeyHeld(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}
export const isWindows = typeof navigator !== 'undefined' && /^Win/.test(navigator.platform);

export interface RootPlatformNavigator {
  userAgent?: string;
  platform?: string;
  userAgentData?: { platform?: string } | null;
}

export type RootPlatform = 'apple' | 'windows' | 'android' | 'chromeos' | 'linux' | 'other';

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

export function markRootPlatform(doc: Document | undefined = typeof document !== 'undefined' ? document : undefined): void {
  if (!doc) return;
  const root = doc.documentElement;
  for (const cls of Array.from(root.classList)) if (cls.startsWith('pn-os-')) return;
  root.classList.add(`pn-os-${rootPlatform(typeof navigator !== 'undefined' ? navigator : null)}`);
}
