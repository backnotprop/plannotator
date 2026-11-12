import { useCallback, useState } from 'react';

export interface UpdateCheckSetting {
  on: boolean;
  env?: boolean;
  onChange: (next: boolean) => void;
}

export function useUpdateCheckSetting(): {
  setting: UpdateCheckSetting | undefined;
  adopt: (serverConfig: Record<string, unknown> | undefined) => void;
} {
  const [state, setState] = useState<{ config: boolean; env?: boolean } | undefined>();

  const adopt = useCallback((serverConfig: Record<string, unknown> | undefined) => {
    const config = serverConfig?.updateCheck;
    const env = serverConfig?.updateCheckEnv;
    setState(typeof config === 'boolean' ? { config, ...(typeof env === 'boolean' && { env }) } : undefined);
  }, []);

  const onChange = useCallback((next: boolean) => {
    setState((current) => (current ? { ...current, config: next } : current));
    void fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateCheck: next }),
    }).catch(() => {});
  }, []);

  return {
    setting: state ? { on: state.env ?? state.config, ...(state.env !== undefined && { env: state.env }), onChange } : undefined,
    adopt,
  };
}
