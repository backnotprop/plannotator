/**
 * The Inbox's one keyboard shortcut: ⌘K on macOS, Ctrl+K elsewhere, opens
 * search. An owner exception (`.product/approved/inbox-search/approval.md`,
 * amendment 2026-10-14) to the rule that the Inbox has no shortcuts until the
 * centralized shortcut system exists; ⌘K is that system's first binding, so it
 * is defined here as a registry scope, matched and spelled by the registry's
 * own functions. It is composed into the Inbox's surface with the others
 * (`packages/inbox/shortcuts/`).
 */
import { defineShortcutScope, formatShortcutBindingTokens, getShortcutPlatform, matchesShortcutBinding } from '@plannotator/ui/shortcuts';
import { isMac, isModKeyHeld } from '@plannotator/ui/utils/platform';
import { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from '../shortcuts/extras';
import { bareKeyAllowed } from '../shortcuts/guards';

/** The search scope; `/` beside ⌘K is an extra (shortcuts/extras.ts). */
export function buildInboxSearchShortcuts(extras: InboxShortcutExtras = INBOX_SHORTCUT_EXTRAS) {
  return defineShortcutScope({
    id: 'inbox-search',
    title: 'Inbox',
    shortcuts: {
      openSearch: {
        description: 'Search',
        // ⌘K first: the chord the Search entry's keycap shows, and the one that works from inside a field.
        bindings: extras.slashSearch ? ['Mod+K', '/'] : ['Mod+K'],
        section: 'Everywhere',
        hint: extras.slashSearch ? '/ only where you are not typing.' : undefined,
        preventDefault: true,
        displayOrder: 0,
      },
    },
  });
}

export const inboxSearchShortcuts = buildInboxSearchShortcuts();

export const OPEN_SEARCH_BINDING = inboxSearchShortcuts.shortcuts.openSearch.bindings[0]!;

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>;

/**
 * Whether a keydown is the open-search chord. Only the platform's own
 * modifier counts (`isModKeyHeld`): on macOS Ctrl+K stays the text fields'
 * delete-to-end-of-line, and Cmd+K elsewhere is left to the system. A chord
 * while an IME composes is the IME's. `mac` is for tests.
 */
export function isOpenSearchKey(event: KeyEventLike, mac: boolean = isMac): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  const own = mac === isMac ? isModKeyHeld(event) : mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (!own || other) return false;
  return matchesShortcutBinding(event, OPEN_SEARCH_BINDING);
}

/**
 * Whether a keydown is `/` for search (an extra): a `/` where the person is
 * not typing, with single keys on. Matched by its character, so it is the key
 * that types `/` on any layout, Shift included where `/` needs it (Shift+7 on
 * German, Swiss and Nordic layouts); ⌘ / Ctrl / Alt still stand it down.
 */
export function isSlashSearchKey(event: KeyboardEvent, scope = inboxSearchShortcuts): boolean {
  if (!scope.shortcuts.openSearch.bindings.includes('/')) return false;
  if (event.key !== '/') return false;
  return bareKeyAllowed(event);
}

/**
 * The window's keydown (capture phase) for the chord. Opens search from
 * anywhere, the reply box and every other field included (a modifier chord
 * eats no typing), and stops the browser's own Ctrl+K / ⌘K; with the palette
 * already open it goes back to the palette's input, the words selected. Another
 * modal dialog (the update, sound or agent-note dialog) keeps the keys. Keys
 * inside an attached HTML page's frame never reach the window.
 */
export function onOpenSearchKey(event: KeyboardEvent, open: (opener: HTMLElement | null) => void, mac: boolean = isMac): void {
  if (isSlashSearchKey(event)) {
    // `/` never fires inside a dialog (the guard): no palette or modal to defer to.
    event.preventDefault();
    open(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    return;
  }
  if (!isOpenSearchKey(event, mac)) return;
  const palette = document.querySelector<HTMLDialogElement>('dialog[data-search-palette][open]');
  if (palette) {
    event.preventDefault();
    const input = palette.querySelector<HTMLInputElement>('[role="combobox"]');
    input?.focus();
    input?.select();
    return;
  }
  if (document.querySelector('dialog[open]:not([data-search-palette]), [aria-modal="true"]:not([data-search-palette])')) return;
  event.preventDefault();
  open(document.activeElement instanceof HTMLElement ? document.activeElement : null);
}

/** The hint the Search entry shows: `⌘K` on macOS, `Ctrl K` elsewhere (the registry's keycaps). */
export function openSearchHint(platform: 'mac' | 'non-mac' = getShortcutPlatform()): string {
  const tokens = formatShortcutBindingTokens(OPEN_SEARCH_BINDING, platform);
  return tokens.join(platform === 'mac' ? '' : ' ');
}

/** The same chord for `aria-keyshortcuts`. */
export function openSearchAriaKeys(mac: boolean = isMac): string {
  return mac ? 'Meta+K' : 'Control+K';
}
