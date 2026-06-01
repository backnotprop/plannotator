/**
 * Tracks whether the user has seen the plan/document Ask AI announcement.
 * Uses cookies so the dismissal survives Plannotator's random localhost ports.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-plan-ai-announcement-seen';
const CURRENT_VERSION = '1';

export function needsPlanAIAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markPlanAIAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}
