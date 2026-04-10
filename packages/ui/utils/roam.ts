/**
 * Roam Integration Utility
 *
 * Cookie-backed settings for Roam Desktop local API integration.
 */

import type { FilenameSeparator } from './obsidian';
import { storage } from './storage';

const STORAGE_KEY_ENABLED = 'plannotator-roam-enabled';
const STORAGE_KEY_GRAPH_NAME = 'plannotator-roam-graph-name';
const STORAGE_KEY_GRAPH_TYPE = 'plannotator-roam-graph-type';
const STORAGE_KEY_TOKEN = 'plannotator-roam-token';
const STORAGE_KEY_PORT = 'plannotator-roam-port';
const STORAGE_KEY_TITLE_FORMAT = 'plannotator-roam-title-format';
const STORAGE_KEY_TITLE_SEPARATOR = 'plannotator-roam-title-separator';
const STORAGE_KEY_SAVE_LOCATION = 'plannotator-roam-save-location';
const STORAGE_KEY_DAILY_NOTE_PARENT = 'plannotator-roam-daily-note-parent';
const STORAGE_KEY_AUTOSAVE = 'plannotator-roam-autosave';
const STORAGE_KEY_BROWSER = 'plannotator-roam-reference-browser';

const DEFAULT_ROAM_PORT = 3333;
const DEFAULT_ROAM_PARENT_BLOCK = '[[Plannotator Plans]]';
const VALID_GRAPH_TYPES = ['hosted', 'offline'] as const;
const VALID_TITLE_SEPARATORS: FilenameSeparator[] = ['space', 'dash', 'underscore'];
const VALID_SAVE_LOCATIONS = ['page', 'daily-note'] as const;

function isGraphType(value: string | null): value is RoamSettings['graphType'] {
  return value !== null && (VALID_GRAPH_TYPES as readonly string[]).includes(value);
}

function isTitleSeparator(value: string | null): value is FilenameSeparator {
  return value !== null && VALID_TITLE_SEPARATORS.includes(value as FilenameSeparator);
}

function isSaveLocation(value: string | null): value is RoamSettings['saveLocation'] {
  return value !== null && VALID_SAVE_LOCATIONS.includes(value as RoamSettings['saveLocation']);
}

function normalizeDailyNoteParent(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_ROAM_PARENT_BLOCK;
}

export function normalizeRoamPort(port: string | number | null | undefined): number {
  const raw = typeof port === 'string' ? port.trim() : port;

  if (raw === null || raw === undefined || raw === '') {
    return DEFAULT_ROAM_PORT;
  }

  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return DEFAULT_ROAM_PORT;
  }

  const normalized = Math.trunc(value);
  if (normalized < 1 || normalized > 65535) {
    return DEFAULT_ROAM_PORT;
  }

  return normalized;
}

export interface RoamSettings {
  enabled: boolean;
  graphName: string;
  graphType: 'hosted' | 'offline';
  token: string;
  port: number;
  titleFormat?: string;
  titleSeparator: FilenameSeparator;
  saveLocation: 'page' | 'daily-note';
  dailyNoteParent: string;
  autoSave: boolean;
  referenceBrowserEnabled: boolean;
}

export function getRoamSettings(): RoamSettings {
  const storedGraphType = storage.getItem(STORAGE_KEY_GRAPH_TYPE);
  const storedTitleSeparator = storage.getItem(STORAGE_KEY_TITLE_SEPARATOR);
  const storedSaveLocation = storage.getItem(STORAGE_KEY_SAVE_LOCATION);

  return {
    enabled: storage.getItem(STORAGE_KEY_ENABLED) === 'true',
    graphName: storage.getItem(STORAGE_KEY_GRAPH_NAME) ?? '',
    graphType: isGraphType(storedGraphType) ? storedGraphType : 'hosted',
    token: storage.getItem(STORAGE_KEY_TOKEN) ?? '',
    port: normalizeRoamPort(storage.getItem(STORAGE_KEY_PORT)),
    titleFormat: storage.getItem(STORAGE_KEY_TITLE_FORMAT) || undefined,
    titleSeparator: isTitleSeparator(storedTitleSeparator) ? storedTitleSeparator : 'space',
    saveLocation: isSaveLocation(storedSaveLocation) ? storedSaveLocation : 'page',
    dailyNoteParent: normalizeDailyNoteParent(storage.getItem(STORAGE_KEY_DAILY_NOTE_PARENT)),
    autoSave: storage.getItem(STORAGE_KEY_AUTOSAVE) === 'true',
    referenceBrowserEnabled: storage.getItem(STORAGE_KEY_BROWSER) === 'true',
  };
}

export function saveRoamSettings(settings: RoamSettings): void {
  const normalizedPort = normalizeRoamPort(settings.port);
  const normalizedGraphType = isGraphType(settings.graphType) ? settings.graphType : 'hosted';
  const normalizedTitleSeparator = isTitleSeparator(settings.titleSeparator) ? settings.titleSeparator : 'space';
  const normalizedSaveLocation = isSaveLocation(settings.saveLocation) ? settings.saveLocation : 'page';
  const normalizedDailyNoteParent = normalizeDailyNoteParent(settings.dailyNoteParent);

  storage.setItem(STORAGE_KEY_ENABLED, String(settings.enabled));
  storage.setItem(STORAGE_KEY_GRAPH_NAME, settings.graphName);
  storage.setItem(STORAGE_KEY_GRAPH_TYPE, normalizedGraphType);
  storage.setItem(STORAGE_KEY_TOKEN, settings.token);
  storage.setItem(STORAGE_KEY_PORT, String(normalizedPort));
  storage.setItem(STORAGE_KEY_TITLE_FORMAT, settings.titleFormat || '');
  storage.setItem(STORAGE_KEY_TITLE_SEPARATOR, normalizedTitleSeparator);
  storage.setItem(STORAGE_KEY_SAVE_LOCATION, normalizedSaveLocation);
  storage.setItem(STORAGE_KEY_DAILY_NOTE_PARENT, normalizedDailyNoteParent);
  storage.setItem(STORAGE_KEY_AUTOSAVE, String(settings.autoSave));
  storage.setItem(STORAGE_KEY_BROWSER, String(settings.referenceBrowserEnabled));
}

export function isRoamConfigured(): boolean {
  const settings = getRoamSettings();
  return settings.enabled && settings.graphName.trim().length > 0 && settings.token.trim().length > 0;
}

export function isRoamBrowserEnabled(): boolean {
  const settings = getRoamSettings();
  return isRoamConfigured() && settings.referenceBrowserEnabled;
}
