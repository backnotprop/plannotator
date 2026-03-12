import { storage } from './storage';

const STORAGE_KEY = 'plannotator-new-settings-seen';
const CURRENT_HINT_VERSION = '0.12.0';

export function hasNewSettings(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_HINT_VERSION;
}

export function markNewSettingsSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_HINT_VERSION);
}
