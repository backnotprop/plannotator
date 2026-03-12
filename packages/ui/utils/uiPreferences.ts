import { storage } from './storage';

const STORAGE_KEY_TOC = 'plannotator-toc-enabled';
const STORAGE_KEY_STICKY_ACTIONS = 'plannotator-sticky-actions-enabled';
const STORAGE_KEY_PLAN_WIDTH = 'plannotator-plan-width';

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

export function getUIPreferences(): UIPreferences {
  const width = storage.getItem(STORAGE_KEY_PLAN_WIDTH);
  return {
    tocEnabled: storage.getItem(STORAGE_KEY_TOC) !== 'false',
    stickyActionsEnabled: storage.getItem(STORAGE_KEY_STICKY_ACTIONS) !== 'false',
    planWidth: (width === 'compact' || width === 'default' || width === 'wide') ? width : 'compact',
  };
}

export function saveUIPreferences(prefs: UIPreferences): void {
  storage.setItem(STORAGE_KEY_TOC, String(prefs.tocEnabled));
  storage.setItem(STORAGE_KEY_STICKY_ACTIONS, String(prefs.stickyActionsEnabled));
  storage.setItem(STORAGE_KEY_PLAN_WIDTH, prefs.planWidth);
}
