/**
 * Power Up in an Inbox reader (the PR page and a thread's guided review), as code review's App does it: one read of
 * `/api/sem-diff/opinion/settings` (the Inbox answers it from this computer's key, packages/server/inbox-power-up.ts),
 * read again on `POWER_UP_CHANGED_EVENT`, and a `PowerUpConfig` for AllFilesCodeView while semantic diffs are drawn
 * (`diffSemantic`), Power Up is on (`diffPowerUp`, config.json `diffOptions.powerUp`) and a key is set. Off in any of
 * them, nothing is asked and nothing is shown.
 *
 * The reader draws each file in its own AllFilesCodeView, so each file reports its own status (`reportFor(path)`);
 * the slot shows their sum. Links the person turned down in code review's list (a cookie) stay turned down here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import { POWER_UP_CHANGED_EVENT, type PowerUpProvider } from '@plannotator/ui/components/settings/SemanticDiffsTab';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { readPowerUpRejected, type PowerUpConfig, type PowerUpStatus } from '@plannotator/review-editor/semDiff/powerUp';

export const POWER_UP_SETTINGS_PATH = '/api/sem-diff/opinion/settings';

interface Configured {
  configured: boolean;
  provider: PowerUpProvider | null;
  endpoint?: string;
  revision: number;
}

export interface InboxPowerUp {
  /** For each file's AllFilesCodeView; null while Power Up is not asked. */
  powerUp: PowerUpConfig | null;
  /** Each file's own status callback, the same function for a path while the reader lives. */
  reportFor: (path: string) => (status: PowerUpStatus) => void;
  /** Every file's status summed; null until a file reported, and while Power Up is not asked. */
  status: PowerUpStatus | null;
  provider: PowerUpProvider | null;
  endpoint?: string;
  retry: () => void;
}

/** The files' statuses as one: counts summed, the first file's reason for being unavailable. */
export function sumPowerUp(statuses: Iterable<PowerUpStatus>): PowerUpStatus | null {
  let sum: PowerUpStatus | null = null;
  for (const status of statuses) {
    sum ??= { asking: 0, answered: 0, links: 0, unavailable: null };
    sum.asking += status.asking;
    sum.answered += status.answered;
    sum.links += status.links;
    sum.unavailable ??= status.unavailable;
  }
  return sum;
}

export function usePowerUp(client: SemDiffClient | null): InboxPowerUp {
  const semanticOn = useConfigValue('diffSemantic');
  const powerUpOn = useConfigValue('diffPowerUp');
  const [configured, setConfigured] = useState<Configured>({ configured: false, provider: null, revision: 0 });
  useEffect(() => {
    if (!client) return;
    let request = 0;
    const load = () => {
      const id = ++request;
      fetch(POWER_UP_SETTINGS_PATH, { headers: { Accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { configured?: unknown; provider?: PowerUpProvider | null; endpoint?: string } | null) => {
          if (id !== request || !data || typeof data.configured !== 'boolean') return;
          setConfigured((previous) => ({ configured: data.configured === true, provider: data.provider ?? null, ...(data.endpoint ? { endpoint: data.endpoint } : {}), revision: previous.revision + 1 }));
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
  const [rejected] = useState<readonly string[]>(() => readPowerUpRejected());
  const [retries, setRetries] = useState(0);
  const active = client != null && semanticOn && powerUpOn && configured.configured;
  const powerUp = useMemo<PowerUpConfig | null>(
    () => (active ? { active, rejected, provider: configured.provider, settingsRevision: configured.revision, retry: retries } : null),
    [active, rejected, configured.provider, configured.revision, retries],
  );

  const statuses = useRef(new Map<string, PowerUpStatus>());
  const [status, setStatus] = useState<PowerUpStatus | null>(null);
  const callbacks = useRef(new Map<string, (status: PowerUpStatus) => void>());
  const reportFor = useCallback((path: string) => {
    let report = callbacks.current.get(path);
    if (!report) {
      report = (next: PowerUpStatus) => {
        statuses.current.set(path, next);
        setStatus(sumPowerUp(statuses.current.values()));
      };
      callbacks.current.set(path, report);
    }
    return report;
  }, []);
  const retry = useCallback(() => setRetries((n) => n + 1), []);
  return {
    powerUp,
    reportFor,
    status: active ? status : null,
    provider: configured.provider,
    ...(configured.endpoint ? { endpoint: configured.endpoint } : {}),
    retry,
  };
}
