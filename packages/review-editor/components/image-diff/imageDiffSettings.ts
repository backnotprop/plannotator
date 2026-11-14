import { useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import type { ImageZoom } from './geometry';

export type ImageDiffMode = 'side' | 'swipe' | 'onion';

export type ImageBackground = 'checker' | 'light' | 'dark';

export interface ImageDiffSettings {
  mode: ImageDiffMode;
  zoom: ImageZoom;
  differences: boolean;
  background: ImageBackground;
}

export const IMAGE_DIFF_MODE_COOKIE = 'plannotator-image-diff-view';
export const IMAGE_BACKGROUND_COOKIE = 'plannotator-image-background';
export const IMAGE_BACKGROUNDS: readonly ImageBackground[] = ['checker', 'light', 'dark'];
export const IMAGE_BACKGROUND_LABEL: Record<ImageBackground, string> = { checker: 'Checkerboard', light: 'Light', dark: 'Dark' };

export const IMAGE_DIFF_MODES: readonly ImageDiffMode[] = ['side', 'swipe', 'onion'];

export const IMAGE_DIFF_MODE_LABEL: Record<ImageDiffMode, string> = {
  side: 'Side by side',
  swipe: 'Swipe',
  onion: 'Onion skin',
};

function readMode(): ImageDiffMode {
  const value = storage.getItem(IMAGE_DIFF_MODE_COOKIE);
  return IMAGE_DIFF_MODES.includes(value as ImageDiffMode) ? (value as ImageDiffMode) : 'side';
}

let current: ImageDiffSettings | null = null;
const listeners = new Set<() => void>();

function readBackground(): ImageBackground {
  const value = storage.getItem(IMAGE_BACKGROUND_COOKIE);
  return IMAGE_BACKGROUNDS.includes(value as ImageBackground) ? (value as ImageBackground) : 'checker';
}

function snapshot(): ImageDiffSettings {
  if (!current) current = { mode: readMode(), zoom: 'fit', differences: false, background: readBackground() };
  return current;
}

export function setImageDiffSettings(patch: Partial<ImageDiffSettings>): void {
  const next = { ...snapshot(), ...patch };
  if (patch.mode && patch.mode !== snapshot().mode) storage.setItem(IMAGE_DIFF_MODE_COOKIE, patch.mode);
  if (patch.background && patch.background !== snapshot().background) storage.setItem(IMAGE_BACKGROUND_COOKIE, patch.background);
  current = next;
  for (const listener of listeners) listener();
}

export function resetImageDiffSettingsForTests(): void {
  current = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useImageDiffSettings(): ImageDiffSettings {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
