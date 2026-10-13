/**
 * One-time gate for the "Ask this session" announcement: Ask AI answered by
 * the agent session that opened Plannotator, and reviews that no longer hold
 * that session. Cookie-backed like the other announcement gates, so a
 * dismissal survives Plannotator's random localhost ports, and shared by the
 * plan editor, the annotate surfaces and the code review editor: dismissing it
 * anywhere retires it everywhere.
 *
 * A plain storage key rather than a settings-registry entry for the same reason
 * as terminalToolsAnnouncement.ts: configStore seeds every registry default
 * into a cookie on first access, so a registry flag could not tell "never seen"
 * from "seeded default".
 */

import { isSessionBridgeProvider, type AIProviderOption } from './aiProvider';
import { storage } from './storage';
import { needsTerminalToolsAnnouncement } from './terminalToolsAnnouncement';

const STORAGE_KEY = 'plannotator-announce-ask-session-seen';
// Bump to re-announce after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsAskSessionAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markAskSessionAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * Whether this page load may show the announcement, latched at mount by the
 * Apps. False while the terminal-tools announcement is still pending: that one
 * takes this load, and this one waits for the next, so a reader never gets two
 * announcements back to back. A reader who dismissed the terminal-tools
 * announcement on an earlier load gets this one on the next load.
 */
export function askSessionAnnouncementPendingThisLoad(): boolean {
  return needsAskSessionAnnouncement() && !needsTerminalToolsAnnouncement();
}

/** The hosts whose sessions answer Ask AI through the session bridge. */
export type AskSessionAgent = 'claude-code' | 'pi' | 'opencode';

function askSessionAgentForHost(host: string | undefined): AskSessionAgent | null {
  return host === 'claude-code' || host === 'pi' || host === 'opencode' ? host : null;
}

/**
 * The agent whose session is connected to THIS Plannotator session right now:
 * the server lists the "Ask this session" provider and its session is not
 * gone. Null everywhere the feature is not live (remote, --tailscale, Windows,
 * the Claude Code mod turned off, `-p`, Pi's event-API path, OpenCode 1, an
 * older CLI): the announcement only describes what the reader can use here.
 */
export function connectedAskSessionAgent(
  providers: ReadonlyArray<Pick<AIProviderOption, 'name' | 'sessionBridge'>>,
): AskSessionAgent | null {
  const bridge = providers.find(isSessionBridgeProvider)?.sessionBridge;
  if (!bridge || bridge.status === 'gone') return null;
  return askSessionAgentForHost(bridge.host);
}

export interface AskSessionAnnouncementGateState {
  /** Latched at mount from askSessionAnnouncementPendingThisLoad(). */
  readonly announcementPending: boolean;
  /** The app has not finished loading its initial payload. */
  readonly isLoading: boolean;
  /**
   * connectedAskSessionAgent() of the capabilities answer. Null while that
   * answer is pending and whenever the session is not connected: deferred,
   * never consumed, so the reader sees it in a session where it is true.
   */
  readonly connectedAgent: AskSessionAgent | null;
  /**
   * Ask AI is actually reachable on this surface (the plan editor's canUseAI,
   * not taken over by the annotate agent terminal; code review's AI button),
   * so "Open Ask AI to try it" never points at nothing.
   */
  readonly askAIUsable: boolean;
  /** Archive browsing, a read-only shared plan, or no Plannotator server. Deferred, not consumed. */
  readonly readOnlySession: boolean;
  /** Plannotator's compact touch shell. Deferred, not consumed. */
  readonly compact: boolean;
  /** Any other first-run dialog is on screen. The chain dialogs never stack. */
  readonly otherFirstRunDialogVisible: boolean;
}

/**
 * Whether the announcement may open now. LAST in each app's first-run chain,
 * after the terminal-tools announcement (see askSessionAnnouncementPendingThisLoad)
 * and behind every dialog that asks the user to decide something, for the
 * reasons terminalToolsAnnouncementCanShow gives. The Apps pass this through
 * useFirstRunAnnouncementWindow, which only lets it open before the reader has
 * started working.
 */
export function askSessionAnnouncementEligible(state: AskSessionAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    state.connectedAgent !== null &&
    state.askAIUsable &&
    !state.readOnlySession &&
    !state.compact &&
    !state.otherFirstRunDialogVisible
  );
}
