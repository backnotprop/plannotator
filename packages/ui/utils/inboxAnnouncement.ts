/**
 * One-time gate for the Plannotator Inbox announcement. Cookie-backed like the
 * other announcement gates, so a dismissal survives Plannotator's random
 * localhost ports, and shared by the plan editor, the annotate surfaces and
 * the code review editor: dismissing it anywhere retires it everywhere.
 *
 * A plain storage key rather than a settings-registry entry for the same reason
 * as terminalToolsAnnouncement.ts: configStore seeds every registry default
 * into a cookie on first access, so a registry flag could not tell "never seen"
 * from "seeded default".
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-announce-inbox-seen';
// Bump to re-announce after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsInboxAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markInboxAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * The page runs inside the VS Code extension's webview, whose theme bridge sets
 * `window.__PLANNOTATOR_VSCODE` before the app script runs (the same flag
 * useEditorAnnotations reads). Read per call, not at module load, so a test can
 * set it.
 */
export function isVSCodeWebview(): boolean {
  return typeof window !== 'undefined'
    && (window as { __PLANNOTATOR_VSCODE?: unknown }).__PLANNOTATOR_VSCODE === true;
}

export interface InboxAnnouncementGateState {
  /** Latched at mount from needsInboxAnnouncement(). */
  readonly announcementPending: boolean;
  /** The app has not finished loading its initial payload. */
  readonly isLoading: boolean;
  /**
   * Archive browsing, a read-only shared plan, or no Plannotator server (the
   * share portal and its demo). Deferred, not consumed.
   */
  readonly readOnlySession: boolean;
  /** Inside the VS Code extension's webview (isVSCodeWebview). Deferred, not consumed. */
  readonly vscodeWebview: boolean;
  /** Any other first-run dialog is on screen. The chain dialogs never stack. */
  readonly otherFirstRunDialogVisible: boolean;
  /**
   * The terminal-tools announcement takes this load: it is pending and can
   * show on this surface, or it was shown on this load. Then this one waits
   * for the next load, so a reader never gets two announcements in a row.
   */
  readonly earlierAnnouncementTakesThisLoad: boolean;
}

/**
 * Whether the Inbox announcement may open now. After the terminal-tools
 * announcement (never on the same load) and before "Ask this session" and the
 * agent-tool offer, which wait while this one takes the load. Unlike its
 * siblings it is not deferred on the compact touch shell: the panel is a video
 * and one link, and the Inbox is read on a phone too. The Apps pass this
 * through useFirstRunAnnouncementWindow, so it only opens before the reader
 * has started working.
 */
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
