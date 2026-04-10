/**
 * Default Notes App Preference
 *
 * Stores the user's preferred notes app for the Cmd/Ctrl+S shortcut.
 * Uses cookies (not localStorage) because each hook invocation runs on a random port.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-default-notes-app';
const DEFAULT_NOTES_APPS = ['obsidian', 'bear', 'octarine', 'roam', 'download', 'ask'] as const;

export type DefaultNotesApp = 'obsidian' | 'bear' | 'octarine' | 'roam' | 'download' | 'ask';

function isDefaultNotesApp(value: string | null): value is DefaultNotesApp {
  return value !== null && DEFAULT_NOTES_APPS.includes(value as DefaultNotesApp);
}

export function getDefaultNotesApp(): DefaultNotesApp {
  const stored = storage.getItem(STORAGE_KEY);
  return isDefaultNotesApp(stored) ? stored : 'ask';
}

export function saveDefaultNotesApp(app: DefaultNotesApp): void {
  storage.setItem(STORAGE_KEY, isDefaultNotesApp(app) ? app : 'ask');
}
