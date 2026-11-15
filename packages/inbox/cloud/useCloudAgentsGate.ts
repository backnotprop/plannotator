import { useEffect, useState } from 'react';
import { inboxApi } from '../api';

export interface CloudAgentsGate {
  shown: boolean | null;
  count: number;
}

/** Settings shows its Cloud agents section: the relay answered once, or an agent is already paired. */
export function cloudAgentsShown(model: { agents?: unknown; available?: boolean } | null | undefined): boolean {
  return Array.isArray(model?.agents) && (model.available !== false || model.agents.length > 0);
}

export function useCloudAgentsGate(enabled: boolean, section: string | null): CloudAgentsGate {
  const [gate, setGate] = useState<CloudAgentsGate>({ shown: null, count: 0 });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    inboxApi.cloudAgents().then(
      (model) => {
        if (!live) return;
        setGate({ shown: cloudAgentsShown(model), count: Array.isArray(model?.agents) ? model.agents.length : 0 });
      },
      () => live && setGate({ shown: false, count: 0 }),
    );
    return () => {
      live = false;
    };
  }, [enabled, section]);
  return gate;
}
