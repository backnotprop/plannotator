/**
 * Cookie-backed like the other announcement gates, so a dismissal survives Plannotator's random
 * localhost ports, and shared by the plan editor, the annotate surfaces and the code review
 * editor: dismissing it anywhere retires it everywhere.
 */

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
  /** Plannotator's compact touch shell. */
  readonly compact: boolean;
  readonly otherFirstRunDialogVisible: boolean;
}

/** Chain gate for the announcement. */
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
