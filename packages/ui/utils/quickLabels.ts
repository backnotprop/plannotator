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

/**
 * The hardcoded one-click positive label behind the 👍 "Looks good" buttons (the selection
 * toolbar's and the HTML pinpoint composer's).
 */
export const THUMBS_UP_LABEL: QuickLabel = {
  id: 'thumbs-up',
  emoji: '👍',
  text: 'Looks good',
  color: 'green',
};

export const DEFAULT_QUICK_LABELS: QuickLabel[] = [
  { id: 'clarify-this',            emoji: '❓', text: 'Clarify this',            color: 'yellow' },
  { id: 'missing-overview',        emoji: '🗺️', text: 'Missing overview',        color: 'purple', tip: 'Provide a narrative overview of what is being built, why it is being built, and how it will be built. Add this before the implementation details.' },
  { id: 'verify-this',             emoji: '🔍', text: 'Verify this',             color: 'orange', tip: 'This seems like an assumption. Verify by reading the actual code before proceeding.' },
  { id: 'give-me-an-example',      emoji: '🔬', text: 'Give me an example',      color: 'cyan', tip: 'This is too abstract. Show a before/after, a sample input/output, or a specific scenario so I can see how this actually works.' },
  { id: 'match-existing-patterns',  emoji: '🧬', text: 'Match existing patterns',  color: 'teal', tip: 'Search the codebase for existing patterns, components, or utilities that already solve this. Reuse what exists rather than introducing a new approach.' },
  { id: 'consider-alternatives',    emoji: '🔄', text: 'Consider alternatives',    color: 'pink', tip: 'Propose 2-3 alternative approaches with trade-offs based on the actual codebase. Also check the Plannotator plans directory (PLANNOTATOR_DATA_DIR or ~/.plannotator/plans/) for prior plan versions that may have already explored or rejected similar approaches.' },
  { id: 'ensure-no-regression',     emoji: '📉', text: 'Ensure no regression',     color: 'amber', tip: 'Verify that this change will not break existing behavior. Identify what could regress and how to protect against it.' },
  { id: 'out-of-scope',            emoji: '🚫', text: 'Out of scope',            color: 'red', tip: 'This is not part of the current task. Remove it and stay focused on what was actually requested.' },
  { id: 'needs-tests',             emoji: '🧪', text: 'Needs tests',             color: 'blue' },
  { id: 'nice-approach',           emoji: '👍', text: 'Looks good',              color: 'green' },
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

/**
 * The Alt/⌥ digit that applies the label at list position `index`: "1".."9" for the first nine,
 * "0" for the tenth, null past it.
 */
export function quickLabelShortcutDigit(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return index === 9 ? '0' : String(index + 1);
}

/** Inverse of {@link quickLabelShortcutDigit}: list position for a digit key. */
export function quickLabelIndexForDigit(digit: number): number {
  return digit === 0 ? 9 : digit - 1;
}

export function moveQuickLabel<T>(labels: readonly T[], from: number, to: number): T[] {
  const next = labels.slice();
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

const MAX_EMOJI_LENGTH = 32;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

function splitGraphemes(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), (s) => s.segment);
  }
  return value ? [value] : [];
}

/**
 * Validate a quick-label emoji: exactly one emoji grapheme (pictographic symbol, ZWJ sequence,
 * skin-tone variant, flag or keycap), surrounding whitespace ignored.
 */
export function parseQuickLabelEmoji(input: string): string | null {
  const value = input.trim();
  if (!value || value.length > MAX_EMOJI_LENGTH) return null;
  const graphemes = splitGraphemes(value);
  if (graphemes.length !== 1) return null;
  const [g] = graphemes;
  if (WHITESPACE_OR_CONTROL.test(g)) return null;
  if (FLAG.test(g) || KEYCAP.test(g) || PICTOGRAPHIC.test(g)) return g;
  return null;
}

/** The emoji a person meant by editing an emoji field that held `current`. */
export function emojiFromFieldInput(value: string, current: string): string | null {
  const graphemes = splitGraphemes(value.trim()).filter((g) => !/^\s+$/u.test(g));
  if (graphemes.length === 1) return parseQuickLabelEmoji(graphemes[0]);
  if (graphemes.length === 2) {
    const at = graphemes.indexOf(current);
    if (at >= 0) return parseQuickLabelEmoji(graphemes[1 - at]);
  }
  return null;
}

/** Find a configured label whose "emoji text" matches an annotation's text field */
export function findLabelByText(annotationText: string): QuickLabel | undefined {
  return getQuickLabels().find(l => `${l.emoji} ${l.text}` === annotationText);
}

export function getLabelColors(color: string): { bg: string; text: string } {
  const colors = LABEL_COLOR_MAP[color];
  if (!colors) return { bg: 'rgba(128,128,128,0.15)', text: '#666' };
  const isDark = document.documentElement.classList.contains('dark');
  return { bg: colors.bg, text: isDark ? colors.darkText : colors.text };
}
