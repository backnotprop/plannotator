import { useEffect, useState } from 'react';
import type { OpenInKind, OpenInPlatform } from '@plannotator/core/open-in-apps';
import { getStoredOpenInApp, setLastOpenInApp } from '../utils/storage';

export interface DetectedOpenInApp {
  id: string;
  label: string;
  kind: OpenInKind;
  icon: string;
}

export interface OpenInAppsAnswer {
  available: boolean;
  apps: DetectedOpenInApp[];
  platform?: OpenInPlatform;
}

const loads = new Map<string, Promise<OpenInAppsAnswer>>();

export function loadOpenInApps(url: string): Promise<OpenInAppsAnswer> {
  let load = loads.get(url);
  if (!load) {
    const unavailable = (): OpenInAppsAnswer => {
      loads.delete(url);
      return { available: false, apps: [] };
    };
    load = fetch(url)
      .then(async (response) => {
        if (!response.ok) return unavailable();
        const data = (await response.json()) as Partial<OpenInAppsAnswer>;
        const platform = data.platform === 'mac' || data.platform === 'win' || data.platform === 'linux' ? data.platform : undefined;
        return { available: data.available === true, apps: Array.isArray(data.apps) ? data.apps : [], ...(platform ? { platform } : {}) };
      })
      .catch(unavailable);
    loads.set(url, load);
  }
  return load;
}

export function useOpenInApps(url: string, enabled = true, retryKey?: string): OpenInAppsAnswer | null {
  const [answer, setAnswer] = useState<OpenInAppsAnswer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadOpenInApps(url).then((next) => {
      if (!cancelled) setAnswer(next);
    });
    return () => {
      cancelled = true;
    };
  }, [url, enabled, retryKey]);
  return enabled ? answer : null;
}

export function useRememberedOpenInApp(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(() => getStoredOpenInApp());
  const remember = (next: string) => {
    setLastOpenInApp(next);
    setId(next);
  };
  return [id, remember];
}
