import { useEffect, useState } from 'react';
import { inboxApi } from '../api';

export interface CloudAgentsGate {
  shown: boolean | null;
  count: number;
}

export function useCloudAgentsGate(enabled: boolean, section: string | null): CloudAgentsGate {
  const [gate, setGate] = useState<CloudAgentsGate>({ shown: null, count: 0 });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    inboxApi.cloudAgents().then(
      (model) => {
        if (!live) return;
        const agents = Array.isArray(model?.agents) ? model.agents : null;
        setGate({ shown: agents !== null && (model.available !== false || agents.length > 0), count: agents?.length ?? 0 });
      },
      () => live && setGate({ shown: false, count: 0 }),
    );
    return () => {
      live = false;
    };
  }, [enabled, section]);
  return gate;
}
