/**
 * Uses cookies (not localStorage) because each hook invocation runs on a random port, and
 * localStorage is scoped by origin including port.
 */

import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-save-enabled';
const STORAGE_KEY_PATH = 'plannotator-save-path';

export interface PlanSaveSettings {
  enabled: boolean;
  customPath: string | null;
}

const DEFAULT_SETTINGS: PlanSaveSettings = {
  enabled: true,
  customPath: null, // null means use default ~/.plannotator/plans/
};

export function getPlanSaveSettings(): PlanSaveSettings {
  const enabled = storage.getItem(STORAGE_KEY_ENABLED);
  const customPath = storage.getItem(STORAGE_KEY_PATH);

  return {
    enabled: enabled !== 'false', // default to true
    customPath: customPath || null,
  };
}

export function savePlanSaveSettings(settings: PlanSaveSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  if (settings.customPath) {
    storage.setItem(STORAGE_KEY_PATH, settings.customPath);
  } else {
    storage.removeItem(STORAGE_KEY_PATH);
  }
}
