/**
 * Diff Type Setup Utility
 *
 * Tracks whether the user has seen the first-run diff type selection dialog.
 * Uses cookies (not localStorage) for the same reason as all other settings.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-diff-type-setup-done';
const CURRENT_VERSION = '2';

export function needsDiffTypeSetup(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markDiffTypeSetupDone(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}
