import { useSyncExternalStore } from 'react';
import { faviconDataUrl, faviconPngDataUrl, isFaviconStyle, type FaviconStyle } from '@plannotator/core/favicon';
import { inboxApi } from './api';

let current: FaviconStyle | null = null;
let chosenHere: FaviconStyle | null = null;
let previewing: FaviconStyle | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function adoptSavedFavicon(style: unknown): void {
  if (chosenHere || !isFaviconStyle(style) || style === current) return;
  current = style;
  notify();
}

export function chooseFavicon(style: FaviconStyle): Promise<void> {
  current = style;
  chosenHere = style;
  previewing = null;
  notify();
  return inboxApi.saveFavicon(style).then(
    () => {},
    () => {},
  );
}

export function previewFavicon(style: FaviconStyle | null): void {
  if (style === previewing) return;
  previewing = style;
  notify();
}

export function faviconPickedHere(): boolean {
  return chosenHere !== null;
}

const onTab = (): FaviconStyle | null => previewing ?? chosenHere;

export function useInboxFavicon(): FaviconStyle | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

export function useInboxFaviconHref(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const style = onTab();
      return style ? faviconDataUrl(style) : null;
    },
    () => null,
  );
}

export function useInboxFaviconBadgeHref(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const style = onTab();
      return style ? faviconPngDataUrl(style) : null;
    },
    () => null,
  );
}

export function resetInboxFaviconForTests(): void {
  current = null;
  chosenHere = null;
  previewing = null;
  notify();
}
