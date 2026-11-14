import { storage } from '@plannotator/ui/utils/storage';

const HINT_ACKED_KEY = 'plannotator-guide-hint-acked';

export function needsGuideHint(): boolean {
  return storage.getItem(HINT_ACKED_KEY) !== 'true';
}

export function markGuideHintSeen(): void {
  storage.setItem(HINT_ACKED_KEY, 'true');
}
