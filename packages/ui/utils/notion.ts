import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-notion-enabled';
const STORAGE_KEY_PARENT_PAGE_ID = 'plannotator-notion-parent-page-id';
const STORAGE_KEY_AUTOSAVE = 'plannotator-notion-autosave';

export interface NotionSettings {
  enabled: boolean;
  parentPageId: string;
  autoSave: boolean;
}

/**
 * Whether this server offers Notion (`notion: true` from /api/plan): it has
 * NOTION_TOKEN and the session is only on this computer. Off until the app
 * hears otherwise, so the option stays hidden everywhere else.
 */
let available = false;

export function setNotionAvailable(value: boolean): void {
  available = value;
}

export function isNotionAvailable(): boolean {
  return available;
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

/** The parent page to save under, or null when Notion is not offered, off, or has no valid page. */
export function getNotionParentPageId(settings: NotionSettings = getNotionSettings()): string | null {
  if (!available || !settings.enabled) return null;
  return normalizeNotionPageId(settings.parentPageId);
}

export function isNotionConfigured(): boolean {
  return getNotionParentPageId() !== null;
}
