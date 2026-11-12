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
    } catch { }
  }
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    directories,
  };
}

export function saveFileBrowserSettings(settings: FileBrowserSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_DIRS, JSON.stringify(settings.directories));
}

export function isFileBrowserEnabled(): boolean {
  const settings = getFileBrowserSettings();
  return settings.enabled && settings.directories.length > 0;
}
