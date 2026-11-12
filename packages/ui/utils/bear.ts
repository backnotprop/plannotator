import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-bear-enabled';
const STORAGE_KEY_CUSTOM_TAGS = 'plannotator-bear-custom-tags';
const STORAGE_KEY_TAG_POSITION = 'plannotator-bear-tag-position';
const STORAGE_KEY_AUTOSAVE = 'plannotator-bear-autosave';

export type TagPosition = 'prepend' | 'append';

export interface BearSettings {
  enabled: boolean;
  customTags: string;
  tagPosition: TagPosition;
  autoSave: boolean;
}

export function getBearSettings(): BearSettings {
  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    customTags: storage.getItem(STORAGE_KEY_CUSTOM_TAGS) ?? '',
    tagPosition: (storage.getItem(STORAGE_KEY_TAG_POSITION) as TagPosition) || 'append',
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
  };
}

export function saveBearSettings(settings: BearSettings): void {
  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_CUSTOM_TAGS, settings.customTags);
  storage.setItem(STORAGE_KEY_TAG_POSITION, settings.tagPosition);
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
}

export function normalizeTags(raw: string): string {
  return raw
    .split(',')
    .map(t => t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-\/]/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''))
    .filter(Boolean)
    .join(', ');
}
