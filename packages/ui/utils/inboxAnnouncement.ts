import { storage } from './storage';

const STORAGE_KEY = 'plannotator-announce-inbox-seen';
const CURRENT_VERSION = '1';

export function needsInboxAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markInboxAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export function isVSCodeWebview(): boolean {
  return typeof window !== 'undefined'
    && (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE === true;
}

export interface InboxAnnouncementGateState {
  readonly announcementPending: boolean;
  readonly isLoading: boolean;
  readonly readOnlySession: boolean;
  readonly vscodeWebview: boolean;
  readonly otherFirstRunDialogVisible: boolean;
  readonly earlierAnnouncementTakesThisLoad: boolean;
}

export function inboxAnnouncementEligible(state: InboxAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    !state.readOnlySession &&
    !state.vscodeWebview &&
    !state.otherFirstRunDialogVisible &&
    !state.earlierAnnouncementTakesThisLoad
  );
}
