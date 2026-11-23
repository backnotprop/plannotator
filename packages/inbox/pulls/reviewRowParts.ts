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

/**
 * Right-to-left text, wherever it sits in Unicode: the scripts by name, and the blocks Unicode keeps for right-to-left
 * writing (DerivedBidiClass gives every code point in them, assigned or not, the class R or AL), past U+FFFF too.
 * A split would put such a title's pieces in the wrong order.
 */
const RTL =
  /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Mende_Kikakui}\p{Script=Adlam}\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFE\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
/** A run this long with no space is a branch, a path or a hash: where it ends is what tells two rows apart. */
const LONG_RUN = 18;
/** The end kept whole: at most this many characters, from the last separator in them when there is one. */
const TAIL_MAX = 14;
const TAIL_MIN = 6;

/** The text's user-perceived characters; null where the runtime can't tell them apart (no `Intl.Segmenter`). */
function graphemes(text: string): string[] | null {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter !== 'function') return null;
  return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);
}

/**
 * A title whose last word is a long unbroken run ("fix/guide-global-comment-keep-words"), split so the row cuts it in
 * its middle: the head gives way with "…" and the tail stays. The run and the tail are counted in user-perceived
 * characters, and the tail is always a piece of that last word, never a space. Null for any other title (cut at its
 * end, as words are), for right-to-left text, whose order a split would break, and where characters can't be told
 * apart (no `Intl.Segmenter`): an end cut never splits a glyph.
 */
export function titleTail(title: string): { head: string; tail: string } | null {
  if (RTL.test(title)) return null;
  const trimmed = title.trimEnd();
  const word = graphemes(trimmed.split(/\s+/).pop() ?? '');
  if (!word || word.length < LONG_RUN) return null;
  const window = word.slice(-TAIL_MAX);
  // Start the tail just after a separator when one is in reach, so it reads as a piece of the name.
  const sep = window.findIndex((c, i) => i < window.length - TAIL_MIN && /^[-/_.:#]$/.test(c));
  const take = sep >= 0 ? window.length - sep - 1 : Math.min(10, window.length);
  if (take <= 0 || take >= word.length) return null;
  const tail = word.slice(-take).join('');
  return { head: trimmed.slice(0, trimmed.length - tail.length), tail };
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
