import { storage } from '@plannotator/ui/utils/storage';

const INTRO_SEEN_KEY = 'plannotator-guide-intro-seen';
const HINT_ACKED_KEY = 'plannotator-guide-hint-acked';
const INTRO_VERSION = '2';

export function needsGuideIntro(): boolean {
  return storage.getItem(INTRO_SEEN_KEY) !== INTRO_VERSION;
}

export function markGuideIntroSeen(): void {
  storage.setItem(INTRO_SEEN_KEY, INTRO_VERSION);
}

export function needsGuideHint(): boolean {
  return storage.getItem(HINT_ACKED_KEY) !== 'true';
}

export function markGuideHintSeen(): void {
  storage.setItem(HINT_ACKED_KEY, 'true');
}
