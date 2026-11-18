import { useEffect, useState } from 'react';
import { inboxApi } from './api';

export const SEM_DIFF_ADVERT_MS = 5_000;
export const SEM_DIFF_ADVERT_RETRY_MS = 60_000;

let advert: unknown = undefined;
let pending: Promise<unknown> | null = null;
let failedUntil = 0;
let retryMs = SEM_DIFF_ADVERT_RETRY_MS;
const listeners = new Set<() => void>();

export function loadSemDiffAdvert(timeoutMs = SEM_DIFF_ADVERT_MS): Promise<unknown> {
  if (advert !== undefined) return Promise.resolve(advert);
  if (Date.now() < failedUntil) return Promise.resolve(null);
  pending ??= inboxApi.semDiff(timeoutMs).then(
    (answer) => {
      advert = answer.advert ?? null;
      for (const listener of listeners) listener();
      return advert;
    },
    () => {
      pending = null;
      failedUntil = Date.now() + retryMs;
      return null;
    },
  );
  return pending;
}

export function semDiffAdvertNow(): unknown {
  if (advert !== undefined) return advert;
  return Date.now() < failedUntil ? null : undefined;
}

export function useSemDiffAdvert(): unknown {
  const [value, setValue] = useState(semDiffAdvertNow);
  useEffect(() => {
    const update = () => setValue(semDiffAdvertNow());
    listeners.add(update);
    if (semDiffAdvertNow() === undefined) void loadSemDiffAdvert();
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return value ?? null;
}

export function resetSemDiffAdvertForTests(retryAfterMs = SEM_DIFF_ADVERT_RETRY_MS): void {
  advert = undefined;
  pending = null;
  failedUntil = 0;
  retryMs = retryAfterMs;
}
