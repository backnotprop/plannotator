import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-octarine-enabled';
const STORAGE_KEY_WORKSPACE = 'plannotator-octarine-workspace';
const STORAGE_KEY_FOLDER = 'plannotator-octarine-folder';
const STORAGE_KEY_AUTOSAVE = 'plannotator-octarine-autosave';

export interface OctarineSettings {
  enabled: boolean;
  workspace: string;
  folder: string;
  autoSave: boolean;
}

export function getOctarineSettings(): OctarineSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    workspace: storage.getItem(STORAGE_KEY_WORKSPACE) ?? '',
    folder: storage.getItem(STORAGE_KEY_FOLDER) || 'plannotator',
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
  };
}

export function saveOctarineSettings(settings: OctarineSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_WORKSPACE, settings.workspace);
  storage.setItem(STORAGE_KEY_FOLDER, settings.folder);
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
}

export function isOctarineConfigured(): boolean {
  const settings = getOctarineSettings();
  return settings.enabled && settings.workspace.trim().length > 0;
}
