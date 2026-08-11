/**
 * Cookie-based storage utility
 *
 * Uses cookies instead of localStorage so settings persist across
 * different ports (each hook invocation uses a random port).
 * Cookies are scoped by domain, not port, so localhost:54321 and
 * localhost:54322 share the same cookies.
 */

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Default backend: cookies.
 * Used instead of localStorage so settings persist across the random ports each
 * hook invocation uses (cookies are scoped by domain, not port).
 */
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
      // Cookie not available
    }
  },
  removeItem(key) {
    try {
      document.cookie = `${key}=; path=/; max-age=0`;
    } catch (e) {
      // Cookie not available
    }
  },
};

// Active backend. Defaults to cookies so Plannotator is unchanged. A host
// (e.g. Workspaces) calls setStorageBackend once at startup to persist settings
// through its own storage instead.
let backend: StorageBackend = cookieBackend;

/** Override the storage backend. Call once at app startup. */
export function setStorageBackend(b: StorageBackend): void {
  backend = b;
}

/** Reset to the default (cookie) backend. Mainly for tests. */
export function resetStorageBackend(): void {
  backend = cookieBackend;
}

/**
 * Get a value from storage (default = cookies)
 */
export function getItem(key: string): string | null {
  return backend.getItem(key);
}

/**
 * Set a value in storage (default = cookies)
 */
export function setItem(key: string, value: string): void {
  backend.setItem(key, value);
}

/**
 * Remove a value from storage (default = cookies)
 */
export function removeItem(key: string): void {
  backend.removeItem(key);
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Auto-close tab setting
 * Values: 'off' | '0' (immediate) | '3' | '5' (seconds)
 * Legacy 'true' maps to '0' for backward compatibility.
 */
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

/**
 * Last-used "Open in app" target.
 * Stores the app id from the OPEN_IN_APPS catalog (packages/shared/open-in-apps.ts).
 * Defaults to 'reveal' (the file manager) when unset.
 */
const OPEN_IN_APP_KEY = 'plannotator-open-in-app';

export function getLastOpenInApp(): string {
  return getItem(OPEN_IN_APP_KEY) ?? 'reveal';
}

export function setLastOpenInApp(id: string): void {
  setItem(OPEN_IN_APP_KEY, id);
}

/**
 * Guide extra instructions (#1265): freeform standing preferences appended to
 * the Guided Review organizer prompt at launch. Stored under a dedicated key
 * rather than inside the plannotator.agents blob so a long text can never push
 * that whole settings cookie past the browser's ~4KB per-cookie limit.
 * Read fresh at launch time by every guide launch surface, so no cross-instance
 * sync machinery is needed. The length bound lives server-side
 * (GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS in @plannotator/shared/guide, mirrored
 * by the launch textarea's maxLength).
 */
const GUIDE_INSTRUCTIONS_KEY = 'plannotator-guide-instructions';

export function getGuideInstructions(): string {
  return getItem(GUIDE_INSTRUCTIONS_KEY) ?? '';
}

export function setGuideInstructions(value: string): void {
  if (value.trim() === '') {
    removeItem(GUIDE_INSTRUCTIONS_KEY);
  } else {
    setItem(GUIDE_INSTRUCTIONS_KEY, value);
  }
}

/**
 * Storage object with localStorage-like API
 */
export const storage = {
  getItem,
  setItem,
  removeItem,
};
