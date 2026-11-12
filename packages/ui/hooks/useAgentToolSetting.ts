import { useCallback, useState } from 'react';
import {
  parseAgentToolSetting,
  saveAgentToolSetting,
  withSavedAgentTool,
  type AgentToolSetting,
} from '../utils/agentToolSetting';

export interface AgentToolSettingState {
  readonly setting: AgentToolSetting | undefined;
  readonly adopt: (serverConfig: unknown) => void;
  readonly save: (enabled: boolean) => Promise<void>;
}

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
