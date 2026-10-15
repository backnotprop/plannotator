import { useEffect, useState } from 'react';
import type { OpenInKind, OpenInPlatform } from '@plannotator/core/open-in-apps';
import { getStoredOpenInApp, setLastOpenInApp } from '../utils/storage';

/**
 * The "Open in" pieces every host shares: the detected-apps list (fetched
 * once per URL and shared by every control on the page) and the remembered
 * app (the `plannotator-open-in-app` cookie, so code review, annotate and the
 * Inbox remember the same editor). OpenInAppButton reads `/api/open-in/apps`;
 * the Inbox reads its own local-only `/api/inbox/open-in/apps`.
 */

export interface DetectedOpenInApp {
  id: string;
  label: string;
  kind: OpenInKind;
  icon: string;
}

export interface OpenInAppsAnswer {
  /** True only when the route says so: false in a remote session, on a route this server does not have, or when the read failed. */
  available: boolean;
  apps: DetectedOpenInApp[];
  /** The host's platform, when the route says (the Inbox's does). */
  platform?: OpenInPlatform;
}

const loads = new Map<string, Promise<OpenInAppsAnswer>>();

/**
 * The apps a route answers, fetched once per URL for the page. Only an
 * answer the route gave is kept: a failed read or a non-OK status (a
 * restarting server, a route this server lacks) is not, so the next caller
 * asks again.
 */
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

/**
 * The detected apps from `url`, or null while they load. `enabled: false`
 * reads nothing (and answers null). A new `retryKey` asks again after a read
 * that did not answer; a kept answer comes back at once.
 */
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

/**
 * The remembered app id (null when nothing was ever picked, so each host
 * chooses its own first default) and the way to remember another (written
 * to the shared cookie).
 */
export function useRememberedOpenInApp(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(() => getStoredOpenInApp());
  const remember = (next: string) => {
    setLastOpenInApp(next);
    setId(next);
  };
  return [id, remember];
}
