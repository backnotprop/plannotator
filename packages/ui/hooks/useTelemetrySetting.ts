import { useCallback, useState } from 'react';

/**
 * The daily ping switch (config.json `telemetry`) for Settings → General: the
 * server's value from serverConfig, written back with POST /api/config, so it
 * is the same switch in plan review, code review, annotate, Pi and the Inbox.
 * Deliberately not a settings-registry entry, like useUpdateCheckSetting.
 */
export interface TelemetrySetting {
  /** The effective value: off while the environment holds it off, else config.json. */
  on: boolean;
  /** What in the environment holds it off (DO_NOT_TRACK, NO_ANON_PING, CI): the switch is locked. */
  env?: string;
  onChange: (next: boolean) => void;
}

export function useTelemetrySetting(): {
  setting: TelemetrySetting | undefined;
  adopt: (serverConfig: Record<string, unknown> | undefined) => void;
} {
  const [state, setState] = useState<{ config: boolean; env?: string } | undefined>();

  const adopt = useCallback((serverConfig: Record<string, unknown> | undefined) => {
    const config = serverConfig?.telemetry;
    const env = serverConfig?.telemetryEnv;
    setState(typeof config === 'boolean' ? { config, ...(typeof env === 'string' && env !== '' && { env }) } : undefined);
  }, []);

  const onChange = useCallback((next: boolean) => {
    setState((current) => (current ? { ...current, config: next } : current));
    void fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telemetry: next }),
    }).catch(() => {});
  }, []);

  return {
    setting: state ? { on: state.env === undefined && state.config, ...(state.env !== undefined && { env: state.env }), onChange } : undefined,
    adopt,
  };
}
