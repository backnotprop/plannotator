/**
 * What a compact Reviews row (approval "inbox-reviews-compact-list", part 1) works out before it draws: its age in a
 * fixed-width column, where a long unbroken title is cut so its end survives, and whether its checks fail.
 */
import { inboxPullIsOpen, type InboxPull, type InboxReviewRow } from '@plannotator/core/inbox-types';

/** "now", "4m", "3h", "2d", "3w", "11mo", "2y": at most four characters, so the age column never grows. */
export function reviewAge(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.min(11, Math.floor(days / 30))}mo`;
  return `${Math.floor(days / 365)}y`;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** A run this long with no space is a branch, a path or a hash: where it ends is what tells two rows apart. */
const LONG_RUN = 18;
/** The end kept whole: at most this many characters, from the last separator in them when there is one. */
const TAIL_MAX = 14;
const TAIL_MIN = 6;

function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
  return Array.from(text);
}

/**
 * A title whose last word is a long unbroken run ("fix/guide-global-comment-keep-words"), split so the row cuts it in
 * its middle: the head gives way with "…" and the tail stays. Null for any other title (cut at its end, as words are)
 * and for right-to-left text, whose order a split would break.
 */
export function titleTail(title: string): { head: string; tail: string } | null {
  if (RTL.test(title)) return null;
  const last = title.split(/\s+/).filter(Boolean).pop() ?? '';
  if (last.length < LONG_RUN) return null;
  const chars = graphemes(title);
  const window = chars.slice(-TAIL_MAX);
  // Start the tail just after a separator when one is in reach, so it reads as a piece of the name.
  const sep = window.findIndex((c, i) => i < window.length - TAIL_MIN && /[-/_.:#]/.test(c));
  const take = sep >= 0 ? window.length - sep - 1 : Math.min(10, window.length);
  if (take <= 0 || take >= chars.length) return null;
  return { head: chars.slice(0, -take).join(''), tail: chars.slice(-take).join('') };
}

/** The open PRs a row speaks for: the ones it owns, else its stack's open layers. */
function openPullsOf(row: InboxReviewRow): InboxPull[] {
  const keys = new Set(row.pull_keys);
  const layers = row.stacks.flatMap((stack) => stack.layers.filter(inboxPullIsOpen));
  const owned = layers.filter((pull) => keys.has(pull.key));
  return owned.length > 0 ? owned : layers;
}

/** One of the row's open PRs has failing checks: the row's red mark. */
export function rowChecksFailing(row: InboxReviewRow): boolean {
  return openPullsOf(row).some((pull) => pull.checks === 'failure');
}
