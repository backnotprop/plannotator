import { useCallback, useState } from 'react';

/**
 * The update-notice switch (PLANNOTATOR_UPDATE_CHECK / `updateCheck`) for
 * Settings → General: the server's value from serverConfig, written back
 * with POST /api/config. Deliberately not a settings-registry entry: the
 * registry is bundled into the portable guides.show viewer, whose pinned
 * build must not change for a Plannotator-only setting.
 */
export interface UpdateCheckSetting {
  /** The effective value: the env var when it decides, else config.json (default true). */
  on: boolean;
  /** PLANNOTATOR_UPDATE_CHECK when it overrides the config file: the switch is locked. */
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
