/**
 * What's new's rules that need no DOM (design of record
 * .product/approved/inbox-whats-new-tldr/): a release row's words, the TL;DR
 * labels' dots, the Latest card's two faces, and the releases in between.
 */
import type { TldrLine, WhatsNewRelease } from './api';

/**
 * What a release's row says, in the approved order: its TL;DR; else its line
 * in the newest saved "Missed recent releases?" table; else the first
 * sentence of its notes; else "No summary".
 */
export type ReleaseWords =
  | { kind: 'tldr'; lines: TldrLine[] }
  | { kind: 'listed'; text: string; from: string }
  | { kind: 'sentence'; text: string }
  | { kind: 'none' };

export function releaseWords(row: Pick<WhatsNewRelease, 'tldr' | 'listed' | 'sentence'>): ReleaseWords {
  const lines = (row.tldr ?? []).filter((l) => l.text.trim() !== '');
  if (lines.length > 0) return { kind: 'tldr', lines };
  const listed = row.listed?.text.trim();
  if (listed) return { kind: 'listed', text: listed, from: row.listed!.in };
  const sentence = row.sentence?.trim();
  if (sentence) return { kind: 'sentence', text: sentence };
  return { kind: 'none' };
}

/** The dot each TL;DR label wears (the one colour system of the page); null: a label outside the set, drawn as plain text. */
const DOTS: Record<string, string> = { new: 'new', changed: 'changed', fixed: 'fixed', removed: 'removed', 'off by default': 'off' };

export function tldrDot(label: string): string | null {
  return DOTS[label.trim().toLowerCase()] ?? null;
}

/**
 * The Latest card: compact (its version, date and two lines, no labels)
 * while the page shows the latest release, whose full TL;DR is right there;
 * full (every line with its label's dot) while another release is open.
 */
export function latestCardFace(showing: string | null, latest: string): 'compact' | 'full' {
  return showing === latest ? 'compact' : 'full';
}

/** a vs b for X.Y.Z versions; anything else compares equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

/** How many of `versions` (deduplicated) are newer than `from` and older than `to`. */
export function releasesBetween(from: string, to: string, versions: Iterable<string>): number {
  let n = 0;
  for (const v of new Set(versions)) if (compareVersions(v, from) > 0 && compareVersions(to, v) > 0) n++;
  return n;
}

/** A TL;DR line's words in parts: `code` spans apart from the text around them. */
export function codeParts(text: string): { code: boolean; text: string }[] {
  const parts = text.split('`');
  // An odd count of backticks leaves the last one unpaired: read it as text.
  if (parts.length % 2 === 0) return [{ code: false, text: text.replace(/`/g, '') }];
  return parts.map((t, i) => ({ code: i % 2 === 1, text: t })).filter((p) => p.text !== '');
}
