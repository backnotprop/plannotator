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

export function agentToolAnnouncementPendingThisLoad(): boolean {
  return needsAgentToolAnnouncement() && !needsTerminalToolsAnnouncement();
}

export function agentToolOfferApplies(setting: AgentToolSetting | undefined): setting is AgentToolSetting {
  return (
    setting !== undefined &&
    (setting.host === 'pi' || setting.host === 'opencode') &&
    !setting.enabled &&
    !setting.configured &&
    setting.env === undefined
  );
}

export function agentToolOfferHostOf(setting: AgentToolSetting | undefined): 'pi' | 'opencode' | null {
  return setting?.host === 'pi' || setting?.host === 'opencode' ? setting.host : null;
}

export interface AgentToolAnnouncementGateState {
  readonly announcementPending: boolean;
  readonly isLoading: boolean;
  readonly setting: AgentToolSetting | undefined;
  readonly readOnlySession: boolean;
  readonly compact: boolean;
  readonly otherFirstRunDialogVisible: boolean;
  readonly earlierAnnouncementMayShow: boolean;
}

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
