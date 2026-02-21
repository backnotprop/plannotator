/**
 * Cookie-based storage utility
 *
 * Uses cookies instead of localStorage so settings persist across
 * different ports (each hook invocation uses a random port).
 * Cookies are scoped by domain, not port, so localhost:54321 and
 * localhost:54322 share the same cookies.
 */

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Get a value from cookie storage
 */
export function getItem(key: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${escapeRegex(key)}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Set a value in cookie storage
 */
export function setItem(key: string, value: string): void {
  try {
    const encoded = encodeURIComponent(value);
    document.cookie = `${key}=${encoded}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
  } catch (e) {
    // Cookie not available
  }
}

/**
 * Remove a value from cookie storage
 */
export function removeItem(key: string): void {
  try {
    document.cookie = `${key}=; path=/; max-age=0`;
  } catch (e) {
    // Cookie not available
  }
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
 * Storage object with localStorage-like API
 */
export const storage = {
  getItem,
  setItem,
  removeItem,
};
