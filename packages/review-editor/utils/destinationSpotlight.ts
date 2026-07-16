import { storage } from '@plannotator/ui/utils/storage';

/**
 * One-time gate for the PR feedback-destination spotlight — the coachmark that
 * points first-time PR reviewers at the header's Agent/GitHub destination
 * switcher. Cookie-based, mirroring the guide-intro and review-setup gates.
 * Versioned so a meaningful revision can re-show it.
 */
const SPOTLIGHT_SEEN_KEY = 'plannotator-review-dest-spotlight-seen';
const SPOTLIGHT_VERSION = '1';

export function needsDestinationSpotlight(): boolean {
  return storage.getItem(SPOTLIGHT_SEEN_KEY) !== SPOTLIGHT_VERSION;
}

export function markDestinationSpotlightSeen(): void {
  storage.setItem(SPOTLIGHT_SEEN_KEY, SPOTLIGHT_VERSION);
}
