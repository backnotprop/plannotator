/**
 * Tracks whether the user has seen the UI 2.0 "look & feel" refresh announcement.
 * Uses cookies so the dismissal survives Plannotator's random localhost ports.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-look-feel-announcement-seen';
// v2: grid is the default again; the dialog became a grid-vs-clean image chooser.
const CURRENT_VERSION = '2';

export function needsLookAndFeelAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markLookAndFeelAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}
