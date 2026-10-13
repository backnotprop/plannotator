/**
 * One-time gate for the terminal-tools announcement (Plannotator TUI and
 * Herdr Annotate). Cookie-backed like the other announcement gates, so a
 * dismissal survives Plannotator's random localhost ports, and shared by the
 * plan editor, the annotate surfaces and the code review editor: dismissing it
 * anywhere retires it everywhere.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-announce-tui-herdr-seen';
// Bump to re-announce after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsTerminalToolsAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markTerminalToolsAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export interface TerminalToolsAnnouncementGateState {
  /**
   * Latched at mount from needsTerminalToolsAnnouncement(). Latched rather than
   * read per render so a dismissal cannot unmount the dialog before its own
   * click handler finishes.
   */
  readonly announcementPending: boolean;
  /** The app has not finished loading its initial payload. */
  readonly isLoading: boolean;
  /**
   * The session has no author to address: archive browsing, a read-only shared
   * plan, and any session with no Plannotator server behind it (the share
   * portal's root and its demo plan included — those are not "shared
   * sessions", so the host must fold that in). Telling a viewer about a CLI
   * they did not open is noise, and the cookie is deliberately NOT consumed,
   * so the next authoring session still shows it.
   */
  readonly readOnlySession: boolean;
  /**
   * Plannotator's compact touch shell. The panel is desktop-shaped (install
   * commands to copy, four outbound links) and a phone is not where anyone
   * installs a terminal tool. Also deferred rather than consumed.
   */
  readonly compact: boolean;
  /**
   * Any other first-run dialog is on screen. The chain dialogs never stack.
   */
  readonly otherFirstRunDialogVisible: boolean;
}

/**
 * Chain gate for the announcement. It is LAST in each app's first-run dialog
 * chain, after every dialog that asks the user to decide something (code
 * review: guide intro, look-and-feel, edit mode, token hover cards; plan and
 * annotate: look-and-feel, goal setup, permission mode).
 *
 * Last rather than first because none of those dialogs consume this cookie:
 * a session that is busy asking questions defers the announcement to the next
 * load instead of burning it. That also puts it in front of the right reader.
 * Someone opening Plannotator for the first time is still learning this app;
 * the people who should hear that it now runs in a terminal are the ones who
 * already answered every setup question, and they see it on their next load.
 */
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
