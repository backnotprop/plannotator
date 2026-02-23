/**
 * Hook for fetching and validating OpenCode agents
 */

import { useState, useEffect, useCallback } from 'react';
import { getAgentSwitchSettings } from '../utils/agentSwitch';

export interface Agent {
  id: string;
  name: string;
  description?: string;
}

export interface UseAgentsResult {
  agents: Agent[];
  isLoading: boolean;
  /** Validate if an agent exists (case-insensitive) */
  validateAgent: (agentName: string) => boolean;
  /** Get warning message if current settings point to invalid agent, null if valid */
  getAgentWarning: () => string | null;
}

/**
 * Fetch available agents from OpenCode API
 * Only fetches when origin is 'opencode'
 */
export function useAgents(origin: 'claude-code' | 'opencode' | 'pi' | null): UseAgentsResult {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (origin !== 'opencode') return;

    setIsLoading(true);
    fetch('/api/agents')
      .then(res => res.json())
      .then((data: { agents?: Agent[] }) => {
        if (data.agents?.length) {
          setAgents(data.agents);
        }
      })
      .catch(() => {
        setAgents([]);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [origin]);

  const validateAgent = useCallback((agentName: string): boolean => {
    if (agents.length === 0) return true; // No agents = can't validate, assume ok
    return agents.some(a => a.id.toLowerCase() === agentName.toLowerCase());
  }, [agents]);

  const getAgentWarning = useCallback((): string | null => {
    if (agents.length === 0) return null; // Can't validate without agents

    const settings = getAgentSwitchSettings();

    if (settings.switchTo === 'disabled') {
      return null;
    }

    if (settings.switchTo === 'custom') {
      if (settings.customName) {
        const exists = validateAgent(settings.customName);
        if (!exists) {
          return `Agent "${settings.customName}" not found in OpenCode. It may cause errors.`;
        }
      }
      return null;
    }

    // Regular agent selection
    const exists = validateAgent(settings.switchTo);
    if (!exists) {
      return `Agent "${settings.switchTo}" not found in OpenCode. Select another or it may cause errors.`;
    }

    return null;
  }, [agents, validateAgent]);

  return {
    agents,
    isLoading,
    validateAgent,
    getAgentWarning,
  };
}
