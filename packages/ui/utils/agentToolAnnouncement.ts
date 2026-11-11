import type { AgentToolSetting } from './agentToolSetting';
import { storage } from './storage';
import { needsTerminalToolsAnnouncement } from './terminalToolsAnnouncement';

const STORAGE_KEY = 'plannotator-announce-agent-tool-seen';
const CURRENT_VERSION = '1';

export function needsAgentToolAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markAgentToolAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

/** Whether this page load may show the offer, latched at mount by the Apps. */
export function agentToolAnnouncementPendingThisLoad(): boolean {
  return needsAgentToolAnnouncement() && !needsTerminalToolsAnnouncement();
}

/**
 * The offer describes something the reader can actually do here: a host whose tool is off by
 * default (Pi, OpenCode 2), still off for the next session.
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

/** The host an open offer names, or null where there is never an offer. */
export function agentToolOfferHostOf(setting: AgentToolSetting | undefined): 'pi' | 'opencode' | null {
  return setting?.host === 'pi' || setting?.host === 'opencode' ? setting.host : null;
}

export interface AgentToolAnnouncementGateState {
  readonly announcementPending: boolean;
  readonly isLoading: boolean;
  readonly setting: AgentToolSetting | undefined;
  readonly readOnlySession: boolean;
  /** Plannotator's compact touch shell. */
  readonly compact: boolean;
  readonly otherFirstRunDialogVisible: boolean;
  readonly earlierAnnouncementMayShow: boolean;
}

/** Whether the offer may open now. */
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
