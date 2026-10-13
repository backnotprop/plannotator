/**
 * One-time gate for the "turn the agent tool on" offer. The `plannotator`
 * agent tool is off by default on Pi and OpenCode 2 (a full tool definition
 * in every request), so those sessions get one offer explaining what turning
 * it on does. Cookie-backed like the other announcement gates, so a dismissal
 * survives Plannotator's random localhost ports, and shared by the plan
 * editor, the annotate surfaces and the code review editor.
 *
 * A plain storage key rather than a settings-registry entry for the same
 * reason as terminalToolsAnnouncement.ts: configStore seeds every registry
 * default into a cookie on first access, so a registry flag could not tell
 * "never seen" from "seeded default".
 */

import type { AgentToolSetting } from './agentToolSetting';
import { storage } from './storage';
import { needsTerminalToolsAnnouncement } from './terminalToolsAnnouncement';

const STORAGE_KEY = 'plannotator-announce-agent-tool-seen';
// Bump to re-offer after a meaningful revision.
const CURRENT_VERSION = '1';

export function needsAgentToolAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markAgentToolAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/**
 * Whether this page load may show the offer, latched at mount by the Apps.
 * False while the terminal-tools announcement is still pending: that one
 * takes this load. The "Ask this session" announcement is ordered ahead of
 * this one per load instead (see `earlierAnnouncementMayShow`), because it
 * only shows in a connected session and a reader who never has one must
 * still get this offer.
 */
export function agentToolAnnouncementPendingThisLoad(): boolean {
  return needsAgentToolAnnouncement() && !needsTerminalToolsAnnouncement();
}

/**
 * The offer describes something the reader can actually do here: a host
 * whose tool is off by default (Pi, OpenCode 2), still off for the next
 * session, never chosen in config.json (someone who turned it off in Settings
 * is not asked again), and not decided by PLANNOTATOR_AGENT_TOOL (a toggle
 * cannot change that).
 */
export function agentToolOfferApplies(setting: AgentToolSetting | undefined): setting is AgentToolSetting {
  return (
    setting !== undefined &&
    (setting.host === 'pi' || setting.host === 'opencode') &&
    !setting.enabled &&
    !setting.configured &&
    setting.env === undefined
  );
}

/**
 * The host an open offer names, or null where there is never an offer. Read
 * from the host alone: after "Turn it on" succeeds the setting is on, and the
 * open dialog must stay to say so.
 */
export function agentToolOfferHostOf(setting: AgentToolSetting | undefined): 'pi' | 'opencode' | null {
  return setting?.host === 'pi' || setting?.host === 'opencode' ? setting.host : null;
}

export interface AgentToolAnnouncementGateState {
  /** Latched at mount from agentToolAnnouncementPendingThisLoad(). */
  readonly announcementPending: boolean;
  /** The app has not finished loading its initial payload. */
  readonly isLoading: boolean;
  /** parseAgentToolSetting() of the session's serverConfig. */
  readonly setting: AgentToolSetting | undefined;
  /**
   * Archive browsing, a read-only shared plan, or no Plannotator server
   * (nothing could write config.json). Deferred, not consumed.
   */
  readonly readOnlySession: boolean;
  /** Plannotator's compact touch shell. Deferred, not consumed. */
  readonly compact: boolean;
  /** Any other first-run dialog is on screen. The chain dialogs never stack. */
  readonly otherFirstRunDialogVisible: boolean;
  /**
   * The "Ask this session" announcement is pending and may still take this
   * load (its capabilities answer is outstanding, or it is eligible). The
   * offer then waits for a later load: never two announcements on one load.
   */
  readonly earlierAnnouncementMayShow: boolean;
}

/**
 * Whether the offer may open now. LAST in each app's first-run chain, after
 * the terminal-tools and "Ask this session" announcements. The Apps pass this
 * through useFirstRunAnnouncementWindow, so it only opens before the reader
 * has started working.
 */
export function agentToolAnnouncementEligible(state: AgentToolAnnouncementGateState): boolean {
  return (
    state.announcementPending &&
    !state.isLoading &&
    agentToolOfferApplies(state.setting) &&
    !state.readOnlySession &&
    !state.compact &&
    !state.otherFirstRunDialogVisible &&
    !state.earlierAnnouncementMayShow
  );
}
