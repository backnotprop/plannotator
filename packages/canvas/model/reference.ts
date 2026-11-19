/**
 * Reference cards: reading them. A card stands for a web page, one of the
 * person's artifacts, or a place in a plan. See `ReferenceObject`.
 */
import type { ReferenceObject, ReferenceTarget } from './types';

/** A web address without its scheme or a trailing slash: what a bare card shows. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${rest}`;
  } catch {
    return url;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The plainest words for where a card points, used when it has no title yet. */
export function referenceAddress(target: ReferenceTarget): string {
  if (target.kind === 'web') return displayUrl(target.url);
  if (target.kind === 'artifact') return target.artifact.split('/').pop() || target.artifact;
  return target.anchor || target.document || '';
}

/** What a card shows, with every fallback applied: nothing here is ever empty for a valid card. */
export function referenceCard(object: ReferenceObject): { title: string; description: string; site: string; image: string | null; icon: string | null } {
  const { target } = object;
  return {
    title: object.title || referenceAddress(target),
    description: object.description ?? '',
    site: object.site || (target.kind === 'web' ? hostOf(target.url) : ''),
    image: object.image ?? null,
    icon: object.icon ?? null,
  };
}

const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

/** The web address a paste holds, when the paste is one address and nothing else. */
export function pastedUrl(text: string): string | null {
  const value = text.trim();
  if (!URL_RE.test(value) || value.length > 2048) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}
