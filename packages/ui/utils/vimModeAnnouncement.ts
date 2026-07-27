/**
 * Tracks whether the user has seen the Vim controls announcement.
 *
 * Cookie-backed storage keeps the dismissal across Plannotator's random
 * localhost ports while still honoring host-provided storage backends.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-vim-mode-announcement-seen';
// v2 is the full interactive introduction with the live settings and HUD
// showcase. Earlier development builds used v1 for a smaller notice.
const CURRENT_VERSION = '2';

/** Return whether the current announcement version has not been dismissed. */
export function needsVimModeAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

/** Persist dismissal of the current announcement version in shared UI storage. */
export function markVimModeAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}
