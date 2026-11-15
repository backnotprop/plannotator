/**
 * A range of a stack's layers as one diff, "Layers i–j" (approval "inbox-pr-dashboard", q-0a2467a4): the compare from
 * the branch layer i is based on (the head of layer i-1) to the head of layer j, on the PR page beside This layer and
 * Whole stack. Plain functions: the stack page and the PR page draw what these say.
 *
 * - A range is two open layers on one line of the stack (one sits on the other, through merged layers between); a
 *   sibling branch's layer is never in it.
 * - A range of one is that layer; a range from the lowest open layer of its line is Whole stack up to its top.
 * - i and j are the stack page's own numbers: a layer's place in the stack, bottom first, merged layers counted.
 */
import { inboxPullAncestors, inboxPullIsOpen, type InboxPull, type InboxPullStack } from '@plannotator/core/inbox-types';
import type { PullViewScope } from '../pulls/viewScope';

type Stack = Pick<InboxPullStack, 'layers' | 'parents'>;

export interface StackRange {
  /** The lowest layer (i) and the top one (j). */
  first: InboxPull;
  last: InboxPull;
  /** Every layer from i up to j, bottom first, merged ones between included. */
  layers: InboxPull[];
}

/** Two picked layers as a range, whichever was picked first; null when they are not on one line or not both open. */
export function rangeOf(stack: Stack, a: string, b: string): StackRange | null {
  const x = stack.layers.find((l) => l.key === a);
  const y = stack.layers.find((l) => l.key === b);
  if (!x || !y || !inboxPullIsOpen(x) || !inboxPullIsOpen(y)) return null;
  if (x.key === y.key) return { first: x, last: x, layers: [x] };
  for (const [first, last] of [[x, y], [y, x]] as const) {
    const under = inboxPullAncestors(stack, last.key);
    const at = under.findIndex((l) => l.key === first.key);
    if (at >= 0) return { first, last, layers: [...under.slice(0, at + 1).reverse(), last] };
  }
  return null;
}

/** "Layers 6–9": the stack page's numbers for the range's ends. */
export function rangeName(stack: Stack, range: Pick<StackRange, 'first' | 'last'>): string {
  return `Layers ${stack.layers.indexOf(range.first) + 1}–${stack.layers.indexOf(range.last) + 1}`;
}

/** What a range opens: the layer and the PR page's view of it. */
export function rangeOpens(stack: Stack, range: StackRange): { layer: string; scope: PullViewScope } {
  if (range.first.key === range.last.key) return { layer: range.last.key, scope: 'layer' };
  const lowest = !inboxPullAncestors(stack, range.first.key).some(inboxPullIsOpen);
  return { layer: range.last.key, scope: lowest ? 'stack' : `range:${range.first.key}` };
}

/**
 * The view to show for an address's view, checked against the stack as the list has it now: a range whose layers
 * merged, closed or moved off one line is the layer's own diff; one that has come to start at the lowest open layer
 * is Whole stack.
 */
export function liveView(stack: Stack, layerKey: string, view: PullViewScope): PullViewScope {
  if (!view.startsWith('range:')) return view;
  const range = rangeOf(stack, view.slice('range:'.length), layerKey);
  if (!range || range.last.key !== layerKey) return 'layer';
  return rangeOpens(stack, range).scope;
}

/** The next picks after a click on `key` while choosing a range: one end, then the other, then start again. */
export function pickNext(stack: Stack, picked: readonly string[], key: string): string[] {
  const layer = stack.layers.find((l) => l.key === key);
  if (!layer || !inboxPullIsOpen(layer)) return [...picked];
  if (picked.length === 1) {
    if (picked[0] === key) return [];
    return rangeOf(stack, picked[0]!, key) ? [picked[0]!, key] : [key];
  }
  return [key];
}
