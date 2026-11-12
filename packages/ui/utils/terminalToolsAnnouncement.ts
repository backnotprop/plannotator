import { storage } from './storage';

const STORAGE_KEY = 'plannotator-announce-tui-herdr-seen';
const CURRENT_VERSION = '1';

export function needsTerminalToolsAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markTerminalToolsAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export interface TerminalToolsAnnouncementGateState {
  readonly announcementPending: boolean;
  readonly isLoading: boolean;
  readonly readOnlySession: boolean;
  readonly compact: boolean;
  readonly otherFirstRunDialogVisible: boolean;
}

export function terminalToolsAnnouncementCanShow(
  state: TerminalToolsAnnouncementGateState,
): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    !state.readOnlySession &&
    !state.compact &&
    !state.otherFirstRunDialogVisible
  );
}
