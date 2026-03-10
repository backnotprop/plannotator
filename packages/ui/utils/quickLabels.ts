/**
 * Quick Labels — preset annotation labels for one-click feedback
 *
 * Labels are stored in cookies (same pattern as other settings)
 * so they persist across different port-based sessions.
 */

import { storage } from './storage';

const STORAGE_KEY = 'plannotator-quick-labels';

export interface QuickLabel {
  id: string;     // kebab-case identifier e.g. "needs-tests"
  emoji: string;  // single emoji e.g. "🧪"
  text: string;   // display text e.g. "Needs tests"
  color: string;  // key into LABEL_COLOR_MAP
}

/** Inline styles for label colors (avoids Tailwind dynamic class purging) */
export const LABEL_COLOR_MAP: Record<string, { bg: string; text: string; darkText: string }> = {
  blue:   { bg: 'rgba(59,130,246,0.15)',  text: '#2563eb', darkText: '#60a5fa' },
  red:    { bg: 'rgba(239,68,68,0.15)',   text: '#dc2626', darkText: '#f87171' },
  orange: { bg: 'rgba(249,115,22,0.15)',  text: '#ea580c', darkText: '#fb923c' },
  yellow: { bg: 'rgba(234,179,8,0.15)',   text: '#ca8a04', darkText: '#facc15' },
  purple: { bg: 'rgba(147,51,234,0.15)',  text: '#9333ea', darkText: '#a78bfa' },
  teal:   { bg: 'rgba(20,184,166,0.15)',  text: '#0d9488', darkText: '#2dd4bf' },
  pink:   { bg: 'rgba(236,72,153,0.15)',  text: '#db2777', darkText: '#f472b6' },
  green:  { bg: 'rgba(34,197,94,0.15)',   text: '#16a34a', darkText: '#4ade80' },
};

export const DEFAULT_QUICK_LABELS: QuickLabel[] = [
  { id: 'needs-tests',         emoji: '🧪', text: 'Needs tests',         color: 'blue' },
  { id: 'security-concern',    emoji: '🔒', text: 'Security concern',    color: 'red' },
  { id: 'break-this-up',       emoji: '✂️',  text: 'Break this up',       color: 'orange' },
  { id: 'clarify-this-step',   emoji: '❓', text: 'Clarify this step',   color: 'yellow' },
  { id: 'wrong-order',         emoji: '🔀', text: 'Wrong order',         color: 'purple' },
  { id: 'consider-edge-cases', emoji: '🧩', text: 'Consider edge cases', color: 'teal' },
  { id: 'discuss-first',       emoji: '💬', text: 'Discuss first',       color: 'pink' },
  { id: 'nice-approach',       emoji: '👍', text: 'Nice approach',       color: 'green' },
];

export function getQuickLabels(): QuickLabel[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_QUICK_LABELS;
  try {
    const parsed = JSON.parse(raw) as QuickLabel[];
    return parsed.length > 0 ? parsed : DEFAULT_QUICK_LABELS;
  } catch {
    return DEFAULT_QUICK_LABELS;
  }
}

export function saveQuickLabels(labels: QuickLabel[]): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(labels));
}

export function resetQuickLabels(): void {
  storage.removeItem(STORAGE_KEY);
}

/** Find a configured label whose "emoji text" matches an annotation's text field */
export function findLabelByText(annotationText: string): QuickLabel | undefined {
  return getQuickLabels().find(l => `${l.emoji} ${l.text}` === annotationText);
}

/** Get color styles for a label, respecting dark mode */
export function getLabelColors(color: string): { bg: string; text: string } {
  const colors = LABEL_COLOR_MAP[color];
  if (!colors) return { bg: 'rgba(128,128,128,0.15)', text: '#666' };
  const isDark = document.documentElement.classList.contains('dark');
  return { bg: colors.bg, text: isDark ? colors.darkText : colors.text };
}
