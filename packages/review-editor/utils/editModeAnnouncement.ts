import { storage } from '@plannotator/ui/utils/storage';
import { configStore } from '@plannotator/ui/config';

const STORAGE_KEY = 'plannotator-edit-mode-announcement-seen';
const CURRENT_VERSION = '3';

export function needsEditModeAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markEditModeAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export function enableEditSuggestionsFromAnnouncement(): void {
  configStore.set('editSuggestions', true);
  markEditModeAnnouncementSeen();
}

export interface EditModeAnnouncementGateState {
  announcementPending: boolean;
  isLoading: boolean;
  guideIntroVisible: boolean;
  lookAndFeelVisible: boolean;
}

export function editModeAnnouncementCanShow(state: EditModeAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    !state.guideIntroVisible &&
    !state.lookAndFeelVisible
  );
}
