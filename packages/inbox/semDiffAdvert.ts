import { useEffect, useState } from 'react';
import { inboxApi } from './api';

let advert: unknown = undefined;
let pending: Promise<unknown> | null = null;
const listeners = new Set<() => void>();

export function loadSemDiffAdvert(): Promise<unknown> {
  if (advert !== undefined) return Promise.resolve(advert);
  pending ??= inboxApi.semDiff().then(
    (answer) => {
      advert = answer.advert ?? null;
      for (const listener of listeners) listener();
      return advert;
    },
    () => {
      pending = null;
      return null;
    },
  );
  return pending;
}

export function semDiffAdvertNow(): unknown {
  return advert;
}

export function useSemDiffAdvert(): unknown {
  const [value, setValue] = useState(advert);
  useEffect(() => {
    const update = () => setValue(advert);
    listeners.add(update);
    void loadSemDiffAdvert();
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return value ?? null;
}

export function resetSemDiffAdvertForTests(): void {
  advert = undefined;
  pending = null;
}
