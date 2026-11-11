import { storage } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';

const STORAGE_KEY = 'plannotator-token-hover-announcement-seen';
const CURRENT_VERSION = '1';

export function needsTokenHoverAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markTokenHoverAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export function resolveTokenHoverAnnouncementPending(): boolean {
  return needsTokenHoverAnnouncement() && configStore.get('tokenHoverTrigger') === 'hover';
}

export function shouldConsumeTokenHoverAnnouncement(): boolean {
  return needsTokenHoverAnnouncement() && configStore.get('tokenHoverTrigger') !== 'hover';
}

export interface TokenHoverAnnouncementGateState {
  announcementPending: boolean;
  isLoading: boolean;
  featureAvailable: boolean;
  guideIntroVisible: boolean;
  lookAndFeelVisible: boolean;
  editModeVisible: boolean;
}

export function tokenHoverAnnouncementCanShow(
  state: TokenHoverAnnouncementGateState,
): boolean {
  return (
    state.announcementPending &&
    state.featureAvailable &&
    !state.isLoading &&
    !state.guideIntroVisible &&
    !state.lookAndFeelVisible &&
    !state.editModeVisible
  );
}
