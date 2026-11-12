import { storage } from './storage';

const STORAGE_KEY = 'plannotator-default-notes-app';

export type DefaultNotesApp = 'obsidian' | 'bear' | 'octarine' | 'notion' | 'download' | 'ask';

export function getDefaultNotesApp(): DefaultNotesApp {
  return (storage.getItem(STORAGE_KEY) as DefaultNotesApp) || 'ask';
}

export function saveDefaultNotesApp(app: DefaultNotesApp): void {
  storage.setItem(STORAGE_KEY, app);
}
