/**
 * The Inbox window's text size: Settings → General → Appearance → Text size,
 * 12, 13, 14 or 15 px, 14 by default (the window as it has always been
 * drawn). The whole type ramp in inbox.css scales from it (`--ib-type`, read
 * from `--inbox-text-size` on the document element), so a change applies at
 * once, without a reload.
 *
 * Kept in config.json `inboxTextSize` through POST /api/inbox/settings
 * `{ text_size }`, the way the theme is: config.json wins, adopted from the
 * first settings read and never over a choice made on this page before that
 * read answered. A cookie keeps the last size this browser showed, so a
 * reload paints at that size before the settings read answers.
 */

import { useSyncExternalStore } from 'react';
import { INBOX_TEXT_SIZE_DEFAULT, isInboxTextSize, type InboxTextSize } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export const TEXT_SIZE_COOKIE = 'plannotator-inbox-text-size';
/** The custom property inbox.css reads (`--ib-type: var(--inbox-text-size, 14)`). */
export const TEXT_SIZE_PROPERTY = '--inbox-text-size';

let current: InboxTextSize = readCookie();
let adopted = false;
let chosenHere = false;
const listeners = new Set<() => void>();

function readCookie(): InboxTextSize {
  try {
    const saved = Number(storage.getItem(TEXT_SIZE_COOKIE));
    return isInboxTextSize(saved) ? saved : INBOX_TEXT_SIZE_DEFAULT;
  } catch {
    return INBOX_TEXT_SIZE_DEFAULT;
  }
}

/**
 * Put `size` on the document. At 14 the property is removed, so the window
 * draws from inbox.css's own default, exactly as before the setting existed.
 */
function apply(size: InboxTextSize): void {
  current = size;
  if (typeof document !== 'undefined') {
    const style = document.documentElement.style;
    if (size === INBOX_TEXT_SIZE_DEFAULT) style.removeProperty(TEXT_SIZE_PROPERTY);
    else style.setProperty(TEXT_SIZE_PROPERTY, String(size));
  }
  try {
    if (size === INBOX_TEXT_SIZE_DEFAULT) storage.removeItem(TEXT_SIZE_COOKIE);
    else storage.setItem(TEXT_SIZE_COOKIE, String(size));
  } catch {
    // A page with no cookies still shows the size; it is only not remembered here.
  }
  for (const listener of listeners) listener();
}

/** The cookie's size on the document, before the first render. */
export function applyRememberedTextSize(): void {
  apply(readCookie());
}

/** config.json's size, from the first settings read only, never over a choice made on this page first. */
export function adoptSavedTextSize(size: unknown): void {
  if (adopted) return;
  adopted = true;
  if (!chosenHere && isInboxTextSize(size)) apply(size);
}

/** Picks on this page whose save has not answered yet, and every pick made here. */
let saving = 0;
let picks = 0;

/** Taken before a settings read starts: a read that a pick here could have raced is not applied (`takeSavedTextSize`). */
export function textSizeReadMark(): { picks: number; busy: boolean } {
  return { picks, busy: saving > 0 };
}

/**
 * A size saved after this page read its settings (another window, an agent; `event: prefs`): shown at once. Not when
 * a pick here was being saved when the read started, or came since: the read may predate it, and that save's own
 * event reads again.
 */
export function takeSavedTextSize(size: unknown, mark: { picks: number; busy: boolean }): void {
  if (mark.busy || saving > 0 || mark.picks !== picks) return;
  if (isInboxTextSize(size) && size !== current) apply(size);
}

/** The person's choice: shown at once, then saved to config.json. */
export function chooseTextSize(size: InboxTextSize): Promise<void> {
  chosenHere = true;
  apply(size);
  picks++;
  saving++;
  return inboxApi.saveTextSize(size).then(
    () => {},
    () => {},
  ).finally(() => {
    saving--;
  });
}

export function useInboxTextSize(): InboxTextSize {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => INBOX_TEXT_SIZE_DEFAULT,
  );
}

/** Tests only: a fresh page, at 14, that has not read its settings. */
export function resetInboxTextSizeForTests(): void {
  adopted = false;
  chosenHere = false;
  apply(INBOX_TEXT_SIZE_DEFAULT);
}
