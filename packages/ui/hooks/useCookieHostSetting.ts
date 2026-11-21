import { useCallback, useState } from 'react';

/**
 * "Open Plannotator at plannotator.localhost" (#2184) for Settings → General: on
 * writes `urlHost: "plannotator.localhost"` to config.json, off removes it.
 * The server sends it as `serverConfig.cookieHost` only for a local session
 * (never remote mode or `--tailscale`), and writes it with POST /api/config.
 * Deliberately not a settings-registry entry: the registry is bundled into
 * the portable guides.show viewer, whose pinned build must not change.
 */
export interface CookieHostSetting {
  on: boolean;
  /** PLANNOTATOR_URL_HOST is set (its value; "" when set empty): the switch is locked. */
  env?: string;
  /** config.json holds another `urlHost` (a tailnet name, `auto`, an IP): locked, never replaced. */
  urlHost?: string;
  /** The last save failed: the reason, shown under the switch. */
  error?: string;
  onChange: (next: boolean) => void;
}

/**
 * The cookie switch's one sub line: what it does, or why the switch is
 * locked. `inbox` adds that the Inbox's notifications need allowing once at
 * the new address.
 */
export function cookieHostDescription(
  setting: Pick<CookieHostSetting, 'on' | 'env' | 'urlHost'>,
  options: { inbox?: boolean } = {},
): string {
  if (setting.env !== undefined) {
    return setting.env.trim() === ''
      ? 'Set by PLANNOTATOR_URL_HOST in your environment (empty).'
      : `Set by PLANNOTATOR_URL_HOST=${setting.env.trim()} in your environment.`;
  }
  if (setting.urlHost !== undefined) return `config.json sets urlHost to ${setting.urlHost}; this switch never replaces it.`;
  const notifications = options.inbox ? ' Notifications need allowing once there.' : '';
  return `Keeps Plannotator's cookies away from your other localhost apps. Starts from the next session; this browser's preferences start fresh once.${notifications}`;
}

interface CookieHostState {
  on: boolean;
  env?: string;
  urlHost?: string;
}

function parseState(value: unknown): CookieHostState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.on !== 'boolean') return undefined;
  return {
    on: v.on,
    ...(typeof v.env === 'string' && { env: v.env }),
    ...(typeof v.urlHost === 'string' && { urlHost: v.urlHost }),
  };
}

export function useCookieHostSetting(): {
  setting: CookieHostSetting | undefined;
  adopt: (serverConfig: Record<string, unknown> | undefined) => void;
} {
  const [state, setState] = useState<CookieHostState | undefined>();
  const [error, setError] = useState<string | undefined>();

  const adopt = useCallback((serverConfig: Record<string, unknown> | undefined) => {
    setState(parseState(serverConfig?.cookieHost));
  }, []);

  const onChange = useCallback((next: boolean) => {
    setError(undefined);
    setState((current) => (current ? { ...current, on: next } : current));
    void fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookieHost: next }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown; cookieHost?: unknown };
        const saved = parseState(body.cookieHost);
        if (saved) setState(saved);
        if (!res.ok) {
          if (!saved) setState((current) => (current ? { ...current, on: !next } : current));
          setError(typeof body.error === 'string' ? body.error : 'The setting could not be saved.');
        }
      })
      .catch(() => {
        setState((current) => (current ? { ...current, on: !next } : current));
        setError('The setting could not be saved.');
      });
  }, []);

  return {
    setting: state ? { ...state, ...(error && { error }), onChange } : undefined,
    adopt,
  };
}
