/**
 * Exploration branch only, never for main: the owner compares ways for the agent icon dialog to offer "Animate it"
 * after a pick, and a way back to the dialog. Chosen in the browser's storage, so one build shows them all:
 *   localStorage['plannotator-inbox-dev-icon-flow'] = 'close' (today) | 'stay' | 'toast' | 'beside' | 'selected'
 */
import type { InboxToastModel } from '../components/Toast';

export type IconFlow = 'close' | 'stay' | 'toast' | 'beside' | 'selected';
export const ICON_FLOW_KEY = 'plannotator-inbox-dev-icon-flow';

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function iconFlow(): IconFlow {
  const value = read(ICON_FLOW_KEY);
  return value === 'stay' || value === 'toast' || value === 'beside' || value === 'selected' ? value : 'close';
}

/** A toast from anywhere in the window (App.tsx shows it). */
export const SHOW_TOAST_EVENT = 'plannotator-inbox:show-toast';
export function showToastFromAnywhere(toast: Omit<InboxToastModel, 'id'>): void {
  window.dispatchEvent(new CustomEvent(SHOW_TOAST_EVENT, { detail: toast }));
}
