import { defineShortcutScope, formatShortcutBindingTokens, getShortcutPlatform, matchesShortcutBinding } from '@plannotator/ui/shortcuts';
import { isMac, isModKeyHeld } from '@plannotator/ui/utils/platform';
import { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from '../shortcuts/extras';
import { bareKeyAllowed } from '../shortcuts/guards';

export function buildInboxSearchShortcuts(extras: InboxShortcutExtras = INBOX_SHORTCUT_EXTRAS) {
  return defineShortcutScope({
    id: 'inbox-search',
    title: 'Inbox',
    lettersByCode: true,
    shortcuts: {
      openSearch: {
        description: 'Search',
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

/** Only the platform's own modifier counts: on macOS Ctrl+K stays the text fields' delete-to-end-of-line, and Cmd+K elsewhere is left to the system. A chord while an IME composes is the IME's. */
export function isOpenSearchKey(event: KeyEventLike, mac: boolean = isMac): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  const own = mac === isMac ? isModKeyHeld(event) : mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (!own || other) return false;
  // Also on the K key on a Cyrillic or Greek layout (the scope's `lettersByCode`).
  return matchesShortcutBinding(event, OPEN_SEARCH_BINDING, inboxSearchShortcuts);
}

/** Matched by character, so it is the key that types `/` on any layout, Shift included (Shift+7 on German, Swiss and Nordic layouts). */
export function isSlashSearchKey(event: KeyboardEvent, scope = inboxSearchShortcuts): boolean {
  if (!scope.shortcuts.openSearch.bindings.includes('/')) return false;
  if (event.key !== '/') return false;
  return bareKeyAllowed(event);
}

export function onOpenSearchKey(event: KeyboardEvent, open: (opener: HTMLElement | null) => void, mac: boolean = isMac): void {
  if (isSlashSearchKey(event)) {
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

export function openSearchHint(platform: 'mac' | 'non-mac' = getShortcutPlatform()): string {
  const tokens = formatShortcutBindingTokens(OPEN_SEARCH_BINDING, platform);
  return tokens.join(platform === 'mac' ? '' : ' ');
}

export function openSearchAriaKeys(mac: boolean = isMac): string {
  return mac ? 'Meta+K' : 'Control+K';
}
