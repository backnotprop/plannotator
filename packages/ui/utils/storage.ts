const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const cookieBackend: StorageBackend = {
  getItem(key) {
    try {
      const match = document.cookie.match(new RegExp(`(?:^|; )${escapeRegex(key)}=([^;]*)`));
      return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
      return null;
    }
  },
  setItem(key, value) {
    try {
      const encoded = encodeURIComponent(value);
      document.cookie = `${key}=${encoded}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
    } catch (e) {
    }
  },
  removeItem(key) {
    try {
      document.cookie = `${key}=; path=/; max-age=0`;
    } catch (e) {
    }
  },
};

let backend: StorageBackend = cookieBackend;

export function setStorageBackend(b: StorageBackend): void {
  backend = b;
}

export function resetStorageBackend(): void {
  backend = cookieBackend;
}

export function getItem(key: string): string | null {
  return backend.getItem(key);
}

export function setItem(key: string, value: string): void {
  backend.setItem(key, value);
}

export function removeItem(key: string): void {
  backend.removeItem(key);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AUTO_CLOSE_KEY = 'plannotator-auto-close';

export type AutoCloseDelay = 'off' | '0' | '3' | '5';

export const AUTO_CLOSE_OPTIONS: { value: AutoCloseDelay; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'Tab stays open after submitting' },
  { value: '0', label: 'Immediately', description: 'Tab closes immediately after submitting' },
  { value: '3', label: 'After 3 seconds', description: 'Tab closes 3 seconds after submitting' },
  { value: '5', label: 'After 5 seconds', description: 'Tab closes 5 seconds after submitting' },
];

export function getAutoCloseDelay(): AutoCloseDelay {
  const val = getItem(AUTO_CLOSE_KEY);
  if (val === '0' || val === '3' || val === '5') return val;
  if (val === 'true') return '0'; // backward compat
  return 'off';
}

export function setAutoCloseDelay(delay: AutoCloseDelay): void {
  setItem(AUTO_CLOSE_KEY, delay);
}

const OPEN_IN_APP_KEY = 'plannotator-open-in-app';

export function getLastOpenInApp(): string {
  return getItem(OPEN_IN_APP_KEY) ?? 'reveal';
}

/** The stored "Open in app" id, or null when nothing was ever picked (no 'reveal' default). */
export function getStoredOpenInApp(): string | null {
  return getItem(OPEN_IN_APP_KEY);
}

export function setLastOpenInApp(id: string): void {
  setItem(OPEN_IN_APP_KEY, id);
}

export const storage = {
  getItem,
  setItem,
  removeItem,
};
