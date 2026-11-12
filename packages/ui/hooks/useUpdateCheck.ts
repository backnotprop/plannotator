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
  dismissed: boolean;
  releaseUrl: string;
  featureHighlight?: FeatureHighlight;
  action?: UpdateAction;
  command?: string;
  checkFailing?: { since: string; error: string };
  dismiss: () => void;
}

const DISMISSED_VERSION_KEY = 'update-dismissed-version';

function isDismissedVersion(latestVersion: string): boolean {
  const dismissed = getItem(DISMISSED_VERSION_KEY);
  if (!dismissed) return false;
  return latestVersion.replace(/^v/, '') === dismissed.replace(/^v/, '');
}

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
