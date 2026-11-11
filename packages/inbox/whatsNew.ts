import type { TldrLine, WhatsNewRelease } from './api';

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

const DOTS: Record<string, string> = { new: 'new', changed: 'changed', fixed: 'fixed', removed: 'removed', 'off by default': 'off' };

export function tldrDot(label: string): string | null {
  return DOTS[label.trim().toLowerCase()] ?? null;
}

export function latestCardFace(showing: string | null, latest: string): 'compact' | 'full' {
  return showing === latest ? 'compact' : 'full';
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || [...pa, ...pb].some((n) => !Number.isInteger(n))) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function releasesBetween(from: string, to: string, versions: Iterable<string>): number {
  let n = 0;
  for (const v of new Set(versions)) if (compareVersions(v, from) > 0 && compareVersions(to, v) > 0) n++;
  return n;
}

export function codeParts(text: string): { code: boolean; text: string }[] {
  const parts = text.split('`');
  // An odd count of backticks leaves the last one unpaired: read it as text.
  if (parts.length % 2 === 0) return [{ code: false, text: text.replace(/`/g, '') }];
  return parts.map((t, i) => ({ code: i % 2 === 1, text: t })).filter((p) => p.text !== '');
}
