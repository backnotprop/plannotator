/**
 * Power Up in an Inbox reader (the PR page and a thread's guided review), through code review's own hook
 * (review-editor's semDiff/usePowerUpConfig.ts): one read of `/api/sem-diff/opinion/settings` (the Inbox answers it from
 * this computer's key, packages/server/inbox-power-up.ts), read again on `POWER_UP_CHANGED_EVENT`, and a
 * `PowerUpConfig` for AllFilesCodeView while semantic diffs are drawn (`diffSemantic`), Power Up is on (`diffPowerUp`,
 * config.json `diffOptions.powerUp`) and a key is set. Nothing is asked before the page's first settings read is in
 * (reviewAnalysis.ts), so a slow read never lets the cookie's value ask. Off in any of them, nothing is asked or shown.
 *
 * The reader draws files in several AllFilesCodeViews; each drawn one reports its own status under its own key
 * (`report(key, status)`) and takes it back when it goes (`report(key, null)`: another chapter, a closed section), so
 * the slot sums only what is on the page and a failure in a file no longer drawn never sticks. Links the person
 * turned down in code review's list (a cookie) stay turned down here.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useConfigValue } from '@plannotator/ui/config';
import type { PowerUpProvider } from '@plannotator/ui/components/settings/PowerUpSettings';
import type { SemDiffClient } from '@plannotator/review-editor/semDiff/semDiffClient';
import { readPowerUpRejected, type PowerUpConfig, type PowerUpStatus } from '@plannotator/review-editor/semDiff/powerUp';
import { usePowerUpConfig } from '@plannotator/review-editor/semDiff/usePowerUpConfig';
import { useReviewAnalysisRead } from '../reviewAnalysis';

export interface InboxPowerUp {
  /** For each drawn AllFilesCodeView; null while Power Up is not asked. */
  powerUp: PowerUpConfig | null;
  /** A drawn file view's status under its own key; null when it is no longer drawn. The same function for the reader's life. */
  report: (key: string, status: PowerUpStatus | null) => void;
  /** The drawn views' statuses summed; null until one reported, and while Power Up is not asked. */
  status: PowerUpStatus | null;
  provider: PowerUpProvider | null;
  endpoint?: string;
  /** The key comes from PLANNOTATOR_OPINION_API_KEY. */
  keyFromEnv: boolean;
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

/**
 * One drawn file view's side (GuideReader's GuideDiff): its status callback for AllFilesCodeView, under a key of its
 * own, and its status taken back when the view goes (another chapter), so a failure there never sticks in the sum.
 */
export function usePowerUpReport(report: InboxPowerUp['report'] | undefined): ((status: PowerUpStatus) => void) | undefined {
  const key = useId();
  const onStatus = useMemo(() => (report ? (status: PowerUpStatus) => report(key, status) : undefined), [report, key]);
  useEffect(() => (report ? () => report(key, null) : undefined), [report, key]);
  return onStatus;
}

export function usePowerUp(client: SemDiffClient | null): InboxPowerUp {
  const semanticOn = useConfigValue('diffSemantic');
  const powerUpOn = useConfigValue('diffPowerUp');
  const settled = useReviewAnalysisRead();
  const [rejected] = useState<readonly string[]>(() => readPowerUpRejected());
  const { active, powerUp, settings, retry } = usePowerUpConfig({ client, on: settled && semanticOn && powerUpOn, rejected });

  const statuses = useRef(new Map<string, PowerUpStatus>());
  const [status, setStatus] = useState<PowerUpStatus | null>(null);
  const report = useCallback((key: string, next: PowerUpStatus | null) => {
    if (next) statuses.current.set(key, next);
    else if (!statuses.current.delete(key)) return;
    setStatus(sumPowerUp(statuses.current.values()));
  }, []);
  return {
    powerUp: active ? powerUp : null,
    report,
    status: active ? status : null,
    provider: settings.provider,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    keyFromEnv: settings.source === 'env',
    retry,
  };
}
