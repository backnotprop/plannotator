import { useSyncExternalStore } from 'react';

/**
 * Package changes in code review: the card switch (`card`, default on) and
 * the npm lookup consent (`lookup`, default off), from serverConfig and
 * written back with POST /api/config. The server enforces `lookup`; this
 * store only mirrors it so the card and Settings agree. Deliberately not a
 * settings-registry entry, like useUpdateCheckSetting: the registry is bundled
 * into the portable guides.show viewer.
 */
export interface PackageChangesSettingState {
  card: boolean;
  lookup: boolean;
  /** PLANNOTATOR_PACKAGE_LOOKUP=0: the lookup is off and Settings cannot turn it on. */
  lookupEnv?: false;
}

export interface PackageChangesSetting extends PackageChangesSettingState {
  setCard: (next: boolean) => void;
  /** Resolves true once config.json holds the new value. */
  setLookup: (next: boolean) => Promise<boolean>;
}

const DEFAULT_STATE: PackageChangesSettingState = { card: true, lookup: false };
let state: PackageChangesSettingState | undefined;
const listeners = new Set<() => void>();

function publish(next: PackageChangesSettingState | undefined): void {
  state = next;
  for (const l of listeners) l();
}

/** Adopt serverConfig.packageChanges (called where the app reads /api/diff). */
export function adoptPackageChangesConfig(serverConfig: Record<string, unknown> | undefined): void {
  const raw = serverConfig?.packageChanges as Record<string, unknown> | undefined;
  if (!raw || typeof raw.card !== 'boolean' || typeof raw.lookup !== 'boolean') {
    publish(undefined);
    return;
  }
  publish({ card: raw.card, lookup: raw.lookup, ...(raw.lookupEnv === false && { lookupEnv: false as const }) });
}

/** Test hook. */
export function resetPackageChangesSetting(): void {
  publish(undefined);
}

async function save(patch: Partial<Pick<PackageChangesSettingState, 'card' | 'lookup'>>): Promise<boolean> {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageChanges: patch }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const setCard = (next: boolean): void => {
  const before = state ?? DEFAULT_STATE;
  publish({ ...before, card: next });
  void save({ card: next }).then((ok) => {
    if (!ok) publish({ ...(state ?? DEFAULT_STATE), card: before.card });
  });
};

const setLookup = async (next: boolean): Promise<boolean> => {
  const before = state ?? DEFAULT_STATE;
  if (next && before.lookupEnv === false) return false;
  // Off applies at once; on only once saved, because the server refuses a
  // lookup until config.json says yes.
  if (!next) publish({ ...before, lookup: false });
  const ok = await save({ lookup: next });
  if (ok && next) publish({ ...(state ?? DEFAULT_STATE), lookup: true });
  if (!ok && !next) publish({ ...(state ?? DEFAULT_STATE), lookup: before.lookup });
  return ok;
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The setting, or undefined until the server advertised it (an older server never does). */
export function usePackageChangesSetting(): PackageChangesSetting | undefined {
  const current = useSyncExternalStore(subscribe, () => state, () => undefined);
  return current ? { ...current, setCard, setLookup } : undefined;
}
