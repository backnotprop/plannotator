/**
 * Default Notes App Preference
 *
 * Stores the user's preferred notes app for the Cmd/Ctrl+S shortcut.
 * Uses cookies (not localStorage) because each hook invocation runs on a random port.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-default-notes-app';

export type DefaultNotesApp = 'obsidian' | 'bear' | 'download' | 'ask';

export function getDefaultNotesApp(): DefaultNotesApp {
  return (storage.getItem(STORAGE_KEY) as DefaultNotesApp) || 'ask';
}

export function saveDefaultNotesApp(app: DefaultNotesApp): void {
  storage.setItem(STORAGE_KEY, app);
}
