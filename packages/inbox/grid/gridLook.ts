/**
 * Grid's last look (approval "inbox-agent-grid": "Since", bold lines, and what stays until seen): when this window
 * last showed Grid, kept in this browser (the window's storage: a cookie, as its other settings). A sitting compares with the look from before it; while Grid
 * shows, its look moves with the clock, so what it showed counts as seen next time.
 */
import { getItem, setItem } from '@plannotator/ui/utils/storage';

const KEY = 'plannotator-inbox-grid-look';

export function readGridLook(): number | null {
  const at = Number(getItem(KEY));
  return Number.isFinite(at) && at > 0 ? at : null;
}

export function writeGridLook(at: number): void {
  if (at > (readGridLook() ?? 0)) setItem(KEY, String(at));
}
