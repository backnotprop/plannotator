import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PackageChangeCard, PackageMetadata } from '@plannotator/core/package-changes';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * The page side of package changes. The server works out the cards (GET
 * /api/package-changes, once per diff snapshot and base, shared by every
 * card on the page) and runs the npm lookup per card (POST
 * /api/package-changes/lookup, only after the reviewer allowed it). Nothing
 * here talks to npm.
 */

export type PackageCard = PackageChangeCard & { lookup: { names: string[]; withheld: string[] } };

/** What the page knows about one path: its card, and how many names one lookup click sends in this review. */
export interface PackageCardData {
  card: PackageCard;
  /** Every name any card would send: the consent button's count. */
  sendTotal: number;
}

interface PackageChangesData { cards: PackageCard[]; sendTotal: number }

interface Scope { snapshot: string | undefined; base: string | undefined }

const scopeKey = ({ snapshot, base }: Scope) => `${snapshot ?? ''}\u0000${base ?? ''}`;

const cardsCache = new Map<string, Promise<PackageChangesData | null>>();

function loadCards(scope: Scope): Promise<PackageChangesData | null> {
  const key = scopeKey(scope);
  let hit = cardsCache.get(key);
  if (!hit) {
    const params = new URLSearchParams();
    if (scope.snapshot) params.set('snapshot', scope.snapshot);
    if (scope.base) params.set('base', scope.base);
    hit = fetch(`/api/package-changes?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { cards?: PackageCard[]; lookup?: { total?: number } } | null): PackageChangesData | null => (
        Array.isArray(body?.cards)
          ? { cards: body!.cards, sendTotal: typeof body!.lookup?.total === 'number' ? body!.lookup.total : 0 }
          : null
      ))
      .catch(() => null);
    hit.then((data) => { if (data === null) cardsCache.delete(key); });
    cardsCache.set(key, hit);
    while (cardsCache.size > 8) cardsCache.delete(cardsCache.keys().next().value!);
  }
  return hit;
}

/** This path's card: undefined while loading, null when it has none. */
export function usePackageCard(path: string, scope: Scope, enabled: boolean): PackageCardData | null | undefined {
  const key = scopeKey(scope);
  const [result, setResult] = useState<{ key: string; card: PackageCardData | null } | undefined>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadCards(scope).then((data) => {
      const card = data?.cards.find((c) => c.path === path);
      if (live) setResult({ key: `${key}\u0000${path}`, card: card && data ? { card, sendTotal: data.sendTotal } : null });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, enabled]);
  if (!enabled) return null;
  return result?.key === `${key}\u0000${path}` ? result.card : undefined;
}

export type PackageLookupState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; byKey: Map<string, PackageMetadata>; failure?: string; offline: boolean }
  | { state: 'refused' };

export const packageKey = (name: string, version: string | null) => `${name}@${version ?? ''}`;

interface LookupBody { packages?: PackageMetadata[]; offline?: boolean; failure?: string }
const lookupCache = new Map<string, Promise<PackageLookupState>>();

function loadLookup(scope: Scope, path: string): Promise<PackageLookupState> {
  const key = `${scopeKey(scope)}\u0000${path}`;
  let hit = lookupCache.get(key);
  if (!hit) {
    hit = fetch('/api/package-changes/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot: scope.snapshot, base: scope.base, path }),
    })
      .then(async (res): Promise<PackageLookupState> => {
        if (res.status === 403) return { state: 'refused' };
        if (!res.ok) return { state: 'ready', byKey: new Map(), failure: 'failed', offline: false };
        const body = (await res.json()) as LookupBody;
        const byKey = new Map((body.packages ?? []).map((p) => [packageKey(p.name, p.version), p]));
        return { state: 'ready', byKey, offline: body.offline === true, ...(body.failure ? { failure: body.failure } : {}) };
      })
      .catch((): PackageLookupState => ({ state: 'ready', byKey: new Map(), failure: 'offline', offline: true }));
    // A failed lookup is retried on demand, never served from the cache.
    hit.then((r) => { if (r.state !== 'ready' || r.failure) lookupCache.delete(key); });
    lookupCache.set(key, hit);
  }
  return hit;
}

/** npm details for one card, fetched only while `on` (the reviewer allowed it) and the card has names to send. */
export function usePackageLookup(path: string, scope: Scope, on: boolean, retry: number): PackageLookupState {
  const key = `${scopeKey(scope)}\u0000${path}\u0000${retry}`;
  const [result, setResult] = useState<{ key: string; value: PackageLookupState } | undefined>();
  useEffect(() => {
    if (!on) return;
    let live = true;
    void loadLookup(scope, path).then((value) => { if (live) setResult({ key, value }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on]);
  if (!on) return { state: 'idle' };
  return result?.key === key ? result.value : { state: 'loading' };
}

/** Test hook. */
export function resetPackageChangesCache(): void {
  cardsCache.clear();
  lookupCache.clear();
}

// --- fold state: one remembered choice for every card --------------------------

export const PACKAGE_CHANGES_FOLD_COOKIE = 'plannotator-package-changes-folded';
const foldListeners = new Set<() => void>();
const readFolded = () => storage.getItem(PACKAGE_CHANGES_FOLD_COOKIE) === 'true';

export function setPackageChangesFolded(folded: boolean): void {
  if (folded) storage.setItem(PACKAGE_CHANGES_FOLD_COOKIE, 'true');
  else storage.removeItem(PACKAGE_CHANGES_FOLD_COOKIE);
  for (const l of foldListeners) l();
}

export function usePackageChangesFolded(): boolean {
  return useSyncExternalStore(
    (l) => { foldListeners.add(l); return () => foldListeners.delete(l); },
    readFolded,
    () => false,
  );
}
