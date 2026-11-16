/**
 * What a PR page shows, as one value the address, the page and its kept comments share: `layer` (the PR's own diff),
 * `stack` (Whole stack up to it), `range:<key>` ("Layers i–j", from the layer `key` up to it) and `since:<sha>` (what
 * changed since the person looked at that commit). The address writes `&scope=stack`, `&range=<key>`, `&since=<sha>`.
 */
import type { InboxPullDiffScope } from '@plannotator/core/inbox-types';

export type PullViewScope = 'layer' | 'stack' | `range:${string}` | `since:${string}`;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The diff route's scope and its `from`. */
export function scopeParts(view: PullViewScope): { scope: InboxPullDiffScope; from?: string } {
  if (view.startsWith('range:')) return { scope: 'range', from: view.slice('range:'.length) };
  if (view.startsWith('since:')) return { scope: 'since', from: view.slice('since:'.length) };
  return { scope: view === 'stack' ? 'stack' : 'layer' };
}

/** A view that compares (anything but the PR's own diff): its line comments map to no PR's lines. */
export const isCompare = (view: PullViewScope) => view !== 'layer';

/** The view an address names. */
export function viewScopeOf(params: URLSearchParams): PullViewScope {
  const range = params.get('range');
  if (range) return `range:${range}`;
  const since = params.get('since')?.toLowerCase();
  if (since && SHA.test(since)) return `since:${since}`;
  return params.get('scope') === 'stack' ? 'stack' : 'layer';
}

/** The address's part for a view; nothing for a layer's own diff. */
export function viewScopeHash(view: PullViewScope | undefined): string {
  const { scope, from } = scopeParts(view ?? 'layer');
  if (scope === 'stack') return '&scope=stack';
  if (scope === 'range') return `&range=${encodeURIComponent(from!)}`;
  if (scope === 'since') return `&since=${from}`;
  return '';
}
