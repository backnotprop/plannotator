import { useState, useEffect, useCallback } from 'react';
import { getItem, setItem } from '../utils/storage';

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
  dismiss: () => void;
}

interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  featureHighlight?: FeatureHighlight;
}

const GITHUB_API = 'https://api.github.com/repos/backnotprop/plannotator/releases/latest';

const DISMISSED_VERSION_KEY = 'update-dismissed-version';

// Feature highlights for milestone releases
const FEATURE_HIGHLIGHTS: Record<string, FeatureHighlight> = {
  '0.5.0': {
    title: 'Code Review is here!',
    description: 'Review git diffs with inline annotations. Run /plannotator-review to try it.',
  },
};

function compareVersions(current: string, latest: string): boolean {
  const cleanVersion = (v: string) => v.replace(/^v/, '');
  const currentParts = cleanVersion(current).split('.').map(Number);
  const latestParts = cleanVersion(latest).split('.').map(Number);

  for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
    const curr = currentParts[i] || 0;
    const lat = latestParts[i] || 0;
    if (lat > curr) return true;
    if (lat < curr) return false;
  }
  return false;
}

function isDismissedVersion(latestVersion: string): boolean {
  const dismissed = getItem(DISMISSED_VERSION_KEY);
  if (!dismissed) return false;
  const cleanLatest = latestVersion.replace(/^v/, '');
  const cleanDismissed = dismissed.replace(/^v/, '');
  return cleanLatest === cleanDismissed;
}

export function useUpdateCheck(): UpdateInfo | null {
  const [checkResult, setCheckResult] = useState<VersionCheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const dismiss = useCallback(() => {
    if (!checkResult?.latestVersion) return;
    const clean = checkResult.latestVersion.replace(/^v/, '');
    setItem(DISMISSED_VERSION_KEY, clean);
    setDismissed(true);
  }, [checkResult?.latestVersion]);

  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const currentVersion = typeof __APP_VERSION__ !== 'undefined'
          ? __APP_VERSION__
          : '0.0.0';

        // Debug: ?preview-update=0.5.0 simulates an update to that version
        const urlParams = new URLSearchParams(window.location.search);
        const previewVersion = urlParams.get('preview-update');

        if (previewVersion) {
          const cleanPreview = previewVersion.replace(/^v/, '');
          setDismissed(isDismissedVersion(cleanPreview));
          setCheckResult({
            currentVersion,
            latestVersion: previewVersion,
            updateAvailable: true,
            releaseUrl: `https://github.com/backnotprop/plannotator/releases/tag/v${cleanPreview}`,
            featureHighlight: FEATURE_HIGHLIGHTS[cleanPreview],
          });
          return;
        }

        const response = await fetch(GITHUB_API);
        if (!response.ok) return;

        const release = await response.json();
        const latestVersion = release.tag_name;

        const updateAvailable = compareVersions(currentVersion, latestVersion);

        const cleanLatest = latestVersion.replace(/^v/, '');
        const featureHighlight = FEATURE_HIGHLIGHTS[cleanLatest];

        setDismissed(isDismissedVersion(latestVersion));
        setCheckResult({
          currentVersion,
          latestVersion,
          updateAvailable,
          releaseUrl: release.html_url,
          featureHighlight,
        });
      } catch (e) {
        console.debug('Update check failed:', e);
      }
    };

    checkForUpdates();
  }, []);

  if (!checkResult) return null;

  return {
    ...checkResult,
    dismissed,
    dismiss,
  };
}
