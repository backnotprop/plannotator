/**
 * The thread list's look options (approval "inbox-list-options", 2026-10-30): four checkboxes in the list's ⋮
 * menu, under Tidy and Refresh. All are off by default, so the list is today's until someone turns one on.
 *
 * - Highlight thread subject: the row's title sits in the thread chip's grey pill (`.ib-key`), cut to one line.
 * - Compact rows: two lines instead of three (agents, project, title and time; then the preview).
 * - Hide agent icons: no agents' marks on any row (a screen reader still hears who).
 * - Smaller thread names (the owner, 2026-10-31): an unread row's name at the read size (13.5 px beside a thread,
 *   14 px on a phone), still bold, instead of the bigger unread size of "inbox-row-unread-bigger".
 *
 * Each choice is remembered per browser in a cookie, like the Inbox's other window-only layout choices (the
 * sidebar, the list width, the file view): a cookie ignores the port, so it holds when the Inbox comes back on
 * another one. Nothing is synced to the server.
 */
import { useCallback, useEffect, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import type { IconName } from './icons';

export interface ListLook {
  highlight: boolean;
  compact: boolean;
  hideAgents: boolean;
  smallNames: boolean;
}

export type ListLookKey = keyof ListLook;

export const LIST_LOOK_OFF: ListLook = { highlight: false, compact: false, hideAgents: false, smallNames: false };

export const LIST_LOOK_COOKIES: Readonly<Record<ListLookKey, string>> = {
  highlight: 'plannotator-inbox-list-highlight',
  compact: 'plannotator-inbox-list-compact',
  hideAgents: 'plannotator-inbox-list-hide-agents',
  smallNames: 'plannotator-inbox-list-small-names',
};

/** The ⋮ menu's items, in order: the key, the label and the item's icon. */
export const LIST_LOOK_OPTIONS: ReadonlyArray<{ key: ListLookKey; label: string; icon: IconName }> = [
  { key: 'highlight', label: 'Highlight thread subject', icon: 'pen' },
  { key: 'compact', label: 'Compact rows', icon: 'contents' },
  { key: 'hideAgents', label: 'Hide agent icons', icon: 'eyeOff' },
  { key: 'smallNames', label: 'Smaller thread names', icon: 'collapse' },
];

/** The remembered look; anything but "1" (or no cookie) is off. */
export function readListLook(): ListLook {
  return {
    highlight: storage.getItem(LIST_LOOK_COOKIES.highlight) === '1',
    compact: storage.getItem(LIST_LOOK_COOKIES.compact) === '1',
    hideAgents: storage.getItem(LIST_LOOK_COOKIES.hideAgents) === '1',
    smallNames: storage.getItem(LIST_LOOK_COOKIES.smallNames) === '1',
  };
}

/** The lists showing the remembered look, told when it changes (the one-time list options dialog's Done). */
const lookListeners = new Set<() => void>();

function writeCookie(key: ListLookKey, on: boolean): void {
  if (on) storage.setItem(LIST_LOOK_COOKIES[key], '1');
  else storage.removeItem(LIST_LOOK_COOKIES[key]);
}

/** Remember one option; off removes its cookie, so an untouched browser carries none. */
export function writeListLookOption(key: ListLookKey, on: boolean): void {
  writeCookie(key, on);
  for (const listener of lookListeners) listener();
}

/**
 * Remember the whole look at once (the one-time list options dialog's Done, approval "inbox-list-options-intro"):
 * every list on screen takes it at once, no reload.
 */
export function writeListLook(look: ListLook): void {
  for (const option of LIST_LOOK_OPTIONS) writeCookie(option.key, look[option.key]);
  for (const listener of lookListeners) listener();
}

/** The list column's classes for the look: none when every option is off. */
export function listLookClasses(look: ListLook): string {
  return `${look.highlight ? ' ib-lk-pill' : ''}${look.compact ? ' ib-lk-compact' : ''}${look.hideAgents ? ' ib-lk-noagents' : ''}${look.smallNames ? ' ib-lk-small' : ''}`;
}

/**
 * The list's look, read once from the cookies, and a setter that remembers each change. `remember` false (the
 * onboarding tour, as its sidebar ignores the person's closed sections): every option off, nothing read or written.
 */
export function useListLook(remember = true): [ListLook, (key: ListLookKey, on: boolean) => void] {
  const [look, setLook] = useState<ListLook>(() => (remember ? readListLook() : LIST_LOOK_OFF));
  // A look written elsewhere (the one-time dialog's Done) reaches this list at once.
  useEffect(() => {
    if (!remember) return;
    const reread = () => setLook((current) => {
      const next = readListLook();
      return LIST_LOOK_OPTIONS.every((option) => current[option.key] === next[option.key]) ? current : next;
    });
    lookListeners.add(reread);
    return () => {
      lookListeners.delete(reread);
    };
  }, [remember]);
  const set = useCallback((key: ListLookKey, on: boolean) => {
    if (!remember) return;
    writeListLookOption(key, on);
    setLook((current) => (current[key] === on ? current : { ...current, [key]: on }));
  }, [remember]);
  return [look, set];
}
