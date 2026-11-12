import { isSessionBridgeProvider, type AIProviderOption } from './aiProvider';
import { storage } from './storage';
import { needsTerminalToolsAnnouncement } from './terminalToolsAnnouncement';

const STORAGE_KEY = 'plannotator-announce-ask-session-seen';
const CURRENT_VERSION = '1';

export function needsAskSessionAnnouncement(): boolean {
  return storage.getItem(STORAGE_KEY) !== CURRENT_VERSION;
}

export function markAskSessionAnnouncementSeen(): void {
  storage.setItem(STORAGE_KEY, CURRENT_VERSION);
}

export function askSessionAnnouncementPendingThisLoad(): boolean {
  return needsAskSessionAnnouncement() && !needsTerminalToolsAnnouncement();
}

export type AskSessionAgent = 'claude-code' | 'pi' | 'opencode';

function askSessionAgentForHost(host: string | undefined): AskSessionAgent | null {
  return host === 'claude-code' || host === 'pi' || host === 'opencode' ? host : null;
}

export function connectedAskSessionAgent(
  providers: ReadonlyArray<Pick<AIProviderOption, 'name' | 'sessionBridge'>>,
): AskSessionAgent | null {
  const bridge = providers.find(isSessionBridgeProvider)?.sessionBridge;
  if (!bridge || bridge.status === 'gone') return null;
  return askSessionAgentForHost(bridge.host);
}

export interface AskSessionAnnouncementGateState {
  readonly announcementPending: boolean;
  readonly isLoading: boolean;
  readonly connectedAgent: AskSessionAgent | null;
  readonly askAIUsable: boolean;
  readonly readOnlySession: boolean;
  readonly compact: boolean;
  readonly otherFirstRunDialogVisible: boolean;
}

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
