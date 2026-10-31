/**
 * File Browser Settings
 *
 * Manages settings for the markdown file browser sidebar tab.
 * Users add directories to browse; settings persist via cookies.
 */

import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-filebrowser-enabled';
const STORAGE_KEY_DIRS = 'plannotator-filebrowser-dirs';

export interface FileBrowserSettings {
  enabled: boolean;
  directories: string[];
}

export function getFileBrowserSettings(): FileBrowserSettings {
  const dirsRaw = storage.getItem(STORAGE_KEY_DIRS);
  let directories: string[] = [];
  if (dirsRaw) {
    try {
      directories = JSON.parse(dirsRaw);
    } catch { /* ignore corrupt cookie */ }
  }
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    directories,
  };
}

/** Authorize saved directories before loading indexed drafts, even with Files closed. */
export async function registerFileBrowserDirectories(): Promise<void> {
  const settings = getFileBrowserSettings();
  if (!settings.enabled) return;
  await Promise.allSettled(settings.directories.map((dirPath) =>
    fetch(`/api/reference/files?dirPath=${encodeURIComponent(dirPath)}&registerOnly=1`, { method: "POST" })
  ));
}

export function saveFileBrowserSettings(settings: FileBrowserSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_DIRS, JSON.stringify(settings.directories));
}

export function isFileBrowserEnabled(): boolean {
  const settings = getFileBrowserSettings();
  return settings.enabled && settings.directories.length > 0;
}
