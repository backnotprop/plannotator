import { storage } from '@plannotator/ui/utils/storage';

const SPOTLIGHT_SEEN_KEY = 'plannotator-review-dest-spotlight-seen';
const SPOTLIGHT_VERSION = '1';

export function needsDestinationSpotlight(): boolean {
  return storage.getItem(SPOTLIGHT_SEEN_KEY) !== SPOTLIGHT_VERSION;
}

export function markDestinationSpotlightSeen(): void {
  storage.setItem(SPOTLIGHT_SEEN_KEY, SPOTLIGHT_VERSION);
}
