/**
 * ConfigStore — Unified config resolver for Plannotator
 *
 * Singleton that resolves settings with precedence:
 *   server config file > cookie > default
 *
 * Works both inside and outside React. React components subscribe
 * via useSyncExternalStore (see useConfig.ts).
 *
 * Server-synced settings automatically write back to ~/.plannotator/config.json
 * via a debounced POST /api/config.
 */

import { SETTINGS, type SettingName, type SettingsMap } from './settings';

type Listener = () => void;

/** Deep-merge source into target, recursing into plain objects. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}

/** Server write-back transport: posts a batch of changed server-synced settings. */
export type ServerSyncFn = (payload: Record<string, unknown>) => void;

/** Default = today's inline POST /api/config (best-effort).
    keepalive lets the request outlive page teardown (pagehide flush). */
const defaultServerSync: ServerSyncFn = (payload) => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {}); // best-effort
};

/** Infer the value type from a SettingDef */
type SettingValue<K extends SettingName> = SettingsMap[K] extends { defaultValue: infer D }
  ? D extends (...args: unknown[]) => infer R ? R : D
  : never;

class ConfigStore {
  private values = new Map<string, unknown>();
  private listeners = new Set<Listener>();
  private version = 0;
  private pendingServerWrites: Record<string, unknown> = {};
  private serverSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private pagehideFlushRegistered = false;
  private serverSync: ServerSyncFn = defaultServerSync;
  private loaded = false;

  /**
   * Resolve all settings from the LIVE storage backend (cookie > default) on
   * first use — deliberately not in the constructor. The singleton is created
   * at module import, which for a host app is before configurePlannotatorUI()
   * can install its StorageBackend; resolving eagerly there would write every
   * missing default (including a generated identity) as cookies onto the host's
   * origin. Deferring to first use means a host that configures at startup gets
   * its own backend for the initial resolution too — no cookies are ever
   * written on a configured host. Plannotator is unchanged: same resolution,
   * same default-seeding writes, on first settings access instead of at import.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const [name, def] of Object.entries(SETTINGS)) {
      const fromCookie = def.fromCookie();
      const defaultVal = typeof def.defaultValue === 'function'
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
      const resolved = fromCookie ?? defaultVal;
      this.values.set(name, resolved);
      // Persist generated defaults to cookie so the value is stable across calls
      if (fromCookie === undefined) {
        def.toCookie(resolved as never);
      }
    }
  }

  /**
   * Re-hydrate all settings from the currently installed StorageBackend.
   * ADDITIVE host hook — Plannotator never calls this (eager cookie default unchanged).
   * Host installs a SYNCHRONOUS StorageBackend serving prefetched settings, then calls
   * this to route the initial load through that backend. Precedence after a host call:
   * server (init) > host backend (loadFromBackend) > cookie/default (constructor).
   * Call this BEFORE init(serverConfig): init() always wins, so calling loadFromBackend()
   * after init() would silently overwrite server-supplied settings.
   */
  loadFromBackend(): void {
    this.ensureLoaded();
    for (const [name, def] of Object.entries(SETTINGS)) {
      const fromBackend = def.fromCookie();
      if (fromBackend !== undefined) {
        this.values.set(name, fromBackend);
      } else {
        // Seed the host backend with the resolved default. This matters when
        // the store was already resolved BEFORE the host installed its
        // StorageBackend (e.g. something read a setting pre-configure): those
        // default-seeding writes went to the earlier backend, not this one.
        // Without this, a fresh host store is never populated, so generated
        // defaults (e.g. displayName) regenerate on every reload. In the normal
        // configure-at-startup flow ensureLoaded() above already resolved
        // through the host backend and this loop is a no-op re-read.
        def.toCookie(this.values.get(name) as never);
      }
    }
    this.notify();
  }

  /**
   * Apply server config overrides.
   * Call once after fetching /api/plan or /api/diff.
   *
   * Server values take precedence over the cookie/default already resolved
   * by the constructor. Settings without a server value are left untouched.
   */
  init(serverConfig?: Record<string, unknown>): void {
    this.ensureLoaded();
    if (serverConfig) {
      for (const [name, def] of Object.entries(SETTINGS)) {
        if (def.serverKey && def.fromServer) {
          const fromServer = def.fromServer(serverConfig);
          if (fromServer !== undefined) {
            this.values.set(name, fromServer);
            def.toCookie(fromServer as never);
          }
        }
      }
    }
    this.notify();
  }

  /** Get a resolved config value. Works outside React. */
  get<K extends SettingName>(key: K): SettingValue<K> {
    this.ensureLoaded();
    return this.values.get(key) as SettingValue<K>;
  }

  /** Set a config value. Writes cookie (sync), queues server write-back if applicable. */
  set<K extends SettingName>(key: K, value: SettingValue<K>): void {
    this.ensureLoaded();
    const def = SETTINGS[key];
    this.values.set(key, value);
    def.toCookie(value as never);

    if (def.serverKey && def.toServer) {
      deepMerge(this.pendingServerWrites, def.toServer(value as never) as Record<string, unknown>);
      this.scheduleServerSync();
    }

    this.notify();
  }

  /** Subscribe to changes. Returns unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Override the server write-back transport (default = inline POST /api/config). */
  setServerSync(fn: ServerSyncFn): void {
    this.serverSync = fn;
  }

  resetServerSync(): void { this.serverSync = defaultServerSync; }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private scheduleServerSync(): void {
    // The debounce loses writes when the page goes away within 300ms — and
    // review/plan sessions end abruptly (approve/feedback shuts the server
    // down right after a settings change). A lost write leaves the cookie and
    // ~/.plannotator/config.json disagreeing; on the next session init() then
    // "restores" the stale server value over the cookie. Flush on pagehide so
    // the two stores can't diverge this way.
    if (!this.pagehideFlushRegistered && typeof window !== 'undefined') {
      this.pagehideFlushRegistered = true;
      window.addEventListener('pagehide', () => this.flushServerSync());
    }
    if (this.serverSyncTimer) clearTimeout(this.serverSyncTimer);
    this.serverSyncTimer = setTimeout(() => this.flushServerSync(), 300);
  }

  private flushServerSync(): void {
    if (this.serverSyncTimer) {
      clearTimeout(this.serverSyncTimer);
      this.serverSyncTimer = null;
    }
    if (Object.keys(this.pendingServerWrites).length === 0) return;
    const payload = { ...this.pendingServerWrites };
    this.pendingServerWrites = {};
    this.serverSync(payload);
  }
}

export const configStore = new ConfigStore();
export type { SettingValue };

/** @internal Exported for tests only — lets the lazy-resolution contract be
    verified on a fresh instance without depending on module-graph isolation
    (the singleton may already be resolved by the time a given test file runs). */
export { ConfigStore as ConfigStoreForTest };
