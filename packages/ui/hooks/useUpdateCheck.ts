import { useState, useEffect } from 'react';

declare const __APP_VERSION__: string;

export interface FeatureHighlight {
  title: string;
  description: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  featureHighlight?: FeatureHighlight;
}

const GITHUB_API = 'https://api.github.com/repos/backnotprop/plannotator/releases/latest';

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

export function useUpdateCheck(): UpdateInfo | null {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

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
          setUpdateInfo({
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

        // Check for feature highlight for this version
        const cleanLatest = latestVersion.replace(/^v/, '');
        const featureHighlight = FEATURE_HIGHLIGHTS[cleanLatest];

        setUpdateInfo({
          currentVersion,
          latestVersion,
          updateAvailable,
          releaseUrl: release.html_url,
          featureHighlight,
        });
      } catch (e) {
        // Silently fail - update check is not critical
        console.debug('Update check failed:', e);
      }
    };

    checkForUpdates();
  }, []);

  return updateInfo;
}
