import { configStore } from '../config';

export type PlanWidth = 'compact' | 'default' | 'wide';

export const PLAN_WIDTH_OPTIONS: { id: PlanWidth; label: string; px: number; hint: string }[] = [
  { id: 'compact', label: 'Compact', px: 832, hint: 'Best for reading. Ideal line length for laptops and focused review.' },
  { id: 'default', label: 'Default', px: 1040, hint: 'Balanced. More room for code blocks without sacrificing readability.' },
  { id: 'wide', label: 'Wide', px: 1280, hint: 'For large monitors. Best with diagrams and wide code.' },
];

export interface UIPreferences {
  tocEnabled: boolean;
  stickyActionsEnabled: boolean;
  planWidth: PlanWidth;
}

/**
 * Settings → Display's Auto-open Sidebar, Sticky Actions and Plan Width. The
 * values live in the config registry (`tocEnabled`, `stickyActionsEnabled`,
 * `planWidth`), so they sync to config.json's `displayOptions` like the other
 * Display settings; the cookie keys are unchanged.
 */
export function getUIPreferences(): UIPreferences {
  return {
    tocEnabled: configStore.get('tocEnabled'),
    stickyActionsEnabled: configStore.get('stickyActionsEnabled'),
    planWidth: configStore.get('planWidth'),
  };
}

/** Saves only the keys that changed, so an untouched default is never written to config.json. */
export function saveUIPreferences(prefs: UIPreferences): void {
  const current = getUIPreferences();
  if (prefs.tocEnabled !== current.tocEnabled) configStore.set('tocEnabled', prefs.tocEnabled);
  if (prefs.stickyActionsEnabled !== current.stickyActionsEnabled) {
    configStore.set('stickyActionsEnabled', prefs.stickyActionsEnabled);
  }
  if (prefs.planWidth !== current.planWidth) configStore.set('planWidth', prefs.planWidth);
}
