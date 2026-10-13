import { useCallback, useState } from 'react';
import {
  parseAgentToolSetting,
  saveAgentToolSetting,
  withSavedAgentTool,
  type AgentToolSetting,
} from '../utils/agentToolSetting';

export interface AgentToolSettingState {
  /** Undefined until a serverConfig reporting a tool host is adopted. */
  readonly setting: AgentToolSetting | undefined;
  /** Takes the agent tool fields from a `/api/plan` or `/api/diff` serverConfig. */
  readonly adopt: (serverConfig: unknown) => void;
  /** Writes the switch; resolves once config.json holds it, rejects with a readable Error. */
  readonly save: (enabled: boolean) => Promise<void>;
}

/**
 * The agent tool switch for an App: the Settings row and the one-time offer
 * read the same state, so turning the tool on from the offer shows in
 * Settings at once, and vice versa.
 */
export function useAgentToolSetting(): AgentToolSettingState {
  const [setting, setSetting] = useState<AgentToolSetting | undefined>(undefined);
  const adopt = useCallback((serverConfig: unknown) => {
    setSetting(parseAgentToolSetting(serverConfig));
  }, []);
  const save = useCallback(async (enabled: boolean) => {
    await saveAgentToolSetting(enabled);
    setSetting((current) => (current ? withSavedAgentTool(current, enabled) : current));
  }, []);
  return { setting, adopt, save };
}
