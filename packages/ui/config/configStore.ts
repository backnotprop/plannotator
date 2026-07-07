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

  constructor() {
    // Eagerly resolve all settings from synchronous sources (cookie > default).
    // The store is safe to read from the moment it's created.
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
   * Apply server config overrides.
   * Call once after fetching /api/plan or /api/diff.
   *
   * Server values take precedence over the cookie/default already resolved
   * by the constructor. Settings without a server value are left untouched.
   */
  init(serverConfig?: Record<string, unknown>): void {
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
    return this.values.get(key) as SettingValue<K>;
  }

  /** Set a config value. Writes cookie (sync), queues server write-back if applicable. */
  set<K extends SettingName>(key: K, value: SettingValue<K>): void {
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
    const payload = JSON.stringify(this.pendingServerWrites);
    this.pendingServerWrites = {};
    // keepalive lets the request outlive page teardown (pagehide flush).
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {}); // best-effort
  }
}

export const configStore = new ConfigStore();
export type { SettingValue };
