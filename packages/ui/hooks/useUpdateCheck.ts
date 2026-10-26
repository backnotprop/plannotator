import { useState, useCallback, useMemo } from 'react';
import { getItem, setItem } from '../utils/storage';
import type { UpdateAction, UpdateAdvert, UpdateCheckFailingAdvert } from '../utils/updateNotice';

declare const __APP_VERSION__: string;

export interface FeatureHighlight {
  title: string;
  description: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  /** The Options dot was seen for this version (opening the menu dismisses it). */
  dismissed: boolean;
  releaseUrl: string;
  featureHighlight?: FeatureHighlight;
  /** What updating means here: `script` (Update now), `copy`, `pi`, `opencode`. */
  action?: UpdateAction;
  /** The command for this host, with the remembered install flags. */
  command?: string;
  /**
   * Checking for updates has failed for hours (no update known): the Options
   * menu says so with `command`. `updateAvailable` is false then.
   */
  checkFailing?: { since: string; error: string };
  dismiss: () => void;
}

const DISMISSED_VERSION_KEY = 'update-dismissed-version';

function isDismissedVersion(latestVersion: string): boolean {
  const dismissed = getItem(DISMISSED_VERSION_KEY);
  if (!dismissed) return false;
  return latestVersion.replace(/^v/, '') === dismissed.replace(/^v/, '');
}

/**
 * The Options menu's update state, from the server's advert (`updateAvailable`
 * on /api/plan and /api/diff). The browser never asks GitHub: the machine
 * checks every few minutes (packages/shared/update-check.ts) and the server passes
 * the answer on, or nothing when update checks are off, in a dev build, or on
 * a surface with no server.
 *
 * `?preview-update=0.29.0` still simulates an update, for screenshots.
 */
export function useUpdateCheck(advert?: UpdateAdvert | null, failing?: UpdateCheckFailingAdvert | null): UpdateInfo | null {
  const preview = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const version = new URLSearchParams(window.location.search).get('preview-update');
    return version ? version.replace(/^v/, '') : null;
  }, []);
  const latestVersion = preview ?? advert?.version ?? null;
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const dismiss = useCallback(() => {
    if (!latestVersion) return;
    setItem(DISMISSED_VERSION_KEY, latestVersion);
    setDismissedVersion(latestVersion);
  }, [latestVersion]);

  if (!latestVersion) {
    if (!failing) return null;
    const current = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
    return {
      currentVersion: current,
      latestVersion: current,
      updateAvailable: false,
      dismissed: true,
      releaseUrl: 'https://github.com/backnotprop/plannotator/releases',
      command: failing.command,
      checkFailing: { since: failing.since, error: failing.error },
      dismiss,
    };
  }
  const currentVersion = advert?.current ?? (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0');
  return {
    currentVersion,
    latestVersion,
    updateAvailable: true,
    dismissed: dismissedVersion === latestVersion || isDismissedVersion(latestVersion),
    releaseUrl: advert?.releaseUrl ?? `https://github.com/backnotprop/plannotator/releases/tag/v${latestVersion}`,
    action: advert?.action ?? 'script',
    command: advert?.command ?? 'curl -fsSL https://plannotator.ai/install.sh | bash',
    dismiss,
  };
}
