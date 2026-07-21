import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-notion-enabled';
const STORAGE_KEY_PARENT_PAGE_ID = 'plannotator-notion-parent-page-id';
const STORAGE_KEY_AUTOSAVE = 'plannotator-notion-autosave';

export interface NotionSettings {
  enabled: boolean;
  parentPageId: string;
  autoSave: boolean;
}

/** Extract and normalize a Notion page UUID from either an ID or a page URL. */
export function normalizeNotionPageId(value: string): string | null {
  const match = value.trim().match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i);
  if (!match) return null;
  const compact = match[0].replace(/-/g, '').toLowerCase();
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function getNotionSettings(): NotionSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    parentPageId: storage.getItem(STORAGE_KEY_PARENT_PAGE_ID) ?? '',
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
  };
}

export function saveNotionSettings(settings: NotionSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_PARENT_PAGE_ID, settings.parentPageId);
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
}

export function isNotionConfigured(): boolean {
  const settings = getNotionSettings();
  return settings.enabled && normalizeNotionPageId(settings.parentPageId) !== null;
}
