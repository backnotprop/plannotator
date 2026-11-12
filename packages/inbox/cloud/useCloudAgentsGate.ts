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
      (model) => live && setGate({ shown: model.available !== false || model.agents.length > 0, count: model.agents.length }),
      () => live && setGate({ shown: false, count: 0 }),
    );
    return () => {
      live = false;
    };
  }, [enabled, section]);
  return gate;
}
