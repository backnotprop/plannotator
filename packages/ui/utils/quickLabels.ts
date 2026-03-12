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
  tip?: string;   // optional instruction injected into feedback for the agent
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
  cyan:   { bg: 'rgba(8,145,178,0.15)',   text: '#0891b2', darkText: '#22d3ee' },
  amber:  { bg: 'rgba(180,83,9,0.15)',    text: '#b45309', darkText: '#fbbf24' },
};

export const DEFAULT_QUICK_LABELS: QuickLabel[] = [
  { id: 'clarify-this',            emoji: '❓', text: 'Clarify this',            color: 'yellow' },
  { id: 'missing-overview',        emoji: '🗺️', text: 'Missing overview',        color: 'purple', tip: 'Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details.' },
  { id: 'verify-this',             emoji: '🔍', text: 'Verify this',             color: 'orange', tip: 'This seems like an assumption. Verify by reading the actual code before proceeding.' },
  { id: 'give-me-an-example',      emoji: '🔬', text: 'Give me an example',      color: 'cyan', tip: 'This is too abstract. Show a before/after, a sample input/output, or a specific scenario so I can see how this actually works.' },
  { id: 'match-existing-patterns',  emoji: '🧬', text: 'Match existing patterns',  color: 'teal', tip: 'Search the codebase for existing patterns, components, or utilities that already solve this. Reuse what exists rather than introducing a new approach.' },
  { id: 'consider-alternatives',    emoji: '🔄', text: 'Consider alternatives',    color: 'pink', tip: 'Propose 2-3 alternative approaches with trade-offs based on the actual codebase. Also check ~/.plannotator/plans/ for prior plan versions that may have already explored or rejected similar approaches.' },
  { id: 'ensure-no-regression',     emoji: '📉', text: 'Ensure no regression',     color: 'amber', tip: 'Verify that this change will not break existing behavior. Identify what could regress and how to protect against it.' },
  { id: 'out-of-scope',            emoji: '🚫', text: 'Out of scope',            color: 'red', tip: 'This is not part of the current task. Remove it and stay focused on what was actually requested.' },
  { id: 'needs-tests',             emoji: '🧪', text: 'Needs tests',             color: 'blue' },
  { id: 'nice-approach',           emoji: '👍', text: 'Nice approach',           color: 'green' },
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
