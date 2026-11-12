import { SETTINGS, type SettingName, type SettingsMap } from './settings';

type Listener = () => void;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deletePaths(target: Record<string, unknown>, shape: Record<string, unknown>): void {
  for (const key of Object.keys(shape)) {
    if (!(key in target)) continue;
    if (isPlainObject(target[key]) && isPlainObject(shape[key])) {
      const child = target[key] as Record<string, unknown>;
      deletePaths(child, shape[key] as Record<string, unknown>);
      if (Object.keys(child).length === 0) delete target[key];
    } else {
      delete target[key];
    }
  }
}

export type ServerSyncFn = (payload: Record<string, unknown>) => void;

const defaultServerSync: ServerSyncFn = (payload) => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
};

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
  private serverSyncInstalled = false;
  private serverOverridden = new Set<string>();
  private loaded = false;

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
      if (fromCookie === undefined) {
        def.toCookie(resolved as never);
      }
    }
  }

  loadFromBackend(): void {
    this.ensureLoaded();
    for (const [name, def] of Object.entries(SETTINGS)) {
      const fromBackend = def.fromCookie();
      if (fromBackend !== undefined) {
        this.values.set(name, fromBackend);
      } else {
        def.toCookie(this.values.get(name) as never);
      }
    }
    this.notify();
  }

  init(serverConfig?: Record<string, unknown>): void {
    this.ensureLoaded();
    if (serverConfig) {
      for (const [name, def] of Object.entries(SETTINGS)) {
        if (def.serverKey && def.fromServer) {
          const fromServer = def.fromServer(serverConfig);
          if (fromServer !== undefined) {
            this.values.set(name, fromServer);
            def.toCookie(fromServer as never);
            this.serverOverridden.add(name);
            if (def.toServer) {
              deletePaths(
                this.pendingServerWrites,
                def.toServer(fromServer as never) as Record<string, unknown>,
              );
            }
          }
        }
      }
    }
    this.notify();
  }

  seed<K extends SettingName>(key: K, value: SettingValue<K>): void {
    this.ensureLoaded();
    if (this.serverOverridden.has(key)) return;
    const def = SETTINGS[key];
    this.values.set(key, value);
    def.toCookie(value as never);
    this.notify();
  }

  setLocal<K extends SettingName>(key: K, value: SettingValue<K>): void {
    if (this.serverSyncInstalled) {
      this.set(key, value);
      return;
    }
    this.ensureLoaded();
    const def = SETTINGS[key];
    this.values.set(key, value);
    def.toCookie(value as never);
    this.notify();
  }

  get<K extends SettingName>(key: K): SettingValue<K> {
    this.ensureLoaded();
    return this.values.get(key) as SettingValue<K>;
  }

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

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setServerSync(fn: ServerSyncFn): void {
    this.serverSync = fn;
    this.serverSyncInstalled = true;
  }

  resetServerSync(): void {
    this.serverSync = defaultServerSync;
    this.serverSyncInstalled = false;
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private scheduleServerSync(): void {
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

export { ConfigStore as ConfigStoreForTest };
