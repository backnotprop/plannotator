/**
 * Power Up's config for AllFilesCodeView, one hook for every host (code review's App, the Inbox's readers): one read of
 * `/api/sem-diff/opinion/settings` while a semantic client exists, read again on `POWER_UP_CHANGED_EVENT`, and a
 * `PowerUpConfig` that is active only while the host says it may ask (`on`), a client exists and a key is set.
 *
 * The host passes what differs between them: whether it may ask (its switches, and anything it waits for), the links
 * the person turned down (code review keeps them in state it can change; the Inbox reads them), and, for tests or
 * another server, the settings read.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { POWER_UP_CHANGED_EVENT, type PowerUpProvider } from '@plannotator/ui/components/settings/PowerUpSettings';
import type { SemDiffClient } from './semDiffClient';
import type { PowerUpConfig } from './powerUp';

export const POWER_UP_SETTINGS_PATH = '/api/sem-diff/opinion/settings';

/** What the settings read said (never the key), and how many reads have answered. */
export interface PowerUpSettingsRead {
  configured: boolean;
  provider: PowerUpProvider | null;
  endpoint?: string;
  /** The key comes from PLANNOTATOR_OPINION_API_KEY, so a settings page cannot change it. */
  source?: 'env';
  revision: number;
}

export interface PowerUpConfigOptions {
  client: SemDiffClient | null;
  /** The host's switches (semantic diffs drawn, Power Up on) and anything it waits for. */
  on: boolean;
  /** Links the person turned down. */
  rejected: readonly string[];
  /** The settings read. Default: GET `POWER_UP_SETTINGS_PATH` on the page's origin. */
  readSettings?: () => Promise<unknown>;
}

export interface PowerUpConfigState {
  active: boolean;
  powerUp: PowerUpConfig;
  settings: PowerUpSettingsRead;
  retry: () => void;
}

const readSettingsFromPage = (): Promise<unknown> =>
  fetch(POWER_UP_SETTINGS_PATH, { headers: { Accept: 'application/json' } }).then((res) => (res.ok ? res.json() : null));

export function usePowerUpConfig({ client, on, rejected, readSettings = readSettingsFromPage }: PowerUpConfigOptions): PowerUpConfigState {
  const [settings, setSettings] = useState<PowerUpSettingsRead>({ configured: false, provider: null, revision: 0 });
  const read = useRef(readSettings);
  read.current = readSettings;
  useEffect(() => {
    if (!client) return;
    let request = 0;
    const load = () => {
      const id = ++request;
      read
        .current()
        .then((data) => {
          if (id !== request || !data || typeof data !== 'object') return;
          const answer = data as { configured?: unknown; provider?: PowerUpProvider | null; endpoint?: unknown; source?: unknown };
          setSettings((previous) => ({
            configured: answer.configured === true,
            provider: answer.provider ?? null,
            ...(typeof answer.endpoint === 'string' && answer.endpoint ? { endpoint: answer.endpoint } : {}),
            ...(answer.source === 'env' ? { source: 'env' as const } : {}),
            revision: previous.revision + 1,
          }));
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(POWER_UP_CHANGED_EVENT, load);
    return () => {
      request++;
      window.removeEventListener(POWER_UP_CHANGED_EVENT, load);
    };
  }, [client]);
  const [retries, setRetries] = useState(0);
  const active = client != null && on && settings.configured;
  const powerUp = useMemo<PowerUpConfig>(
    () => ({ active, rejected, provider: settings.provider, settingsRevision: settings.revision, retry: retries }),
    [active, rejected, settings.provider, settings.revision, retries],
  );
  const retry = useCallback(() => setRetries((n) => n + 1), []);
  return { active, powerUp, settings, retry };
}
