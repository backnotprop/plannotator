import { useSyncExternalStore } from 'react';
import { INBOX_TEXT_SIZE_DEFAULT, isInboxTextSize, type InboxTextSize } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

export const TEXT_SIZE_COOKIE = 'plannotator-inbox-text-size';
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
  }
  for (const listener of listeners) listener();
}

export function applyRememberedTextSize(): void {
  apply(readCookie());
}

export function adoptSavedTextSize(size: unknown): void {
  if (adopted) return;
  adopted = true;
  if (!chosenHere && isInboxTextSize(size)) apply(size);
}

export function chooseTextSize(size: InboxTextSize): Promise<void> {
  chosenHere = true;
  apply(size);
  return inboxApi.saveTextSize(size).then(
    () => {},
    () => {},
  );
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

export function resetInboxTextSizeForTests(): void {
  adopted = false;
  chosenHere = false;
  apply(INBOX_TEXT_SIZE_DEFAULT);
}
