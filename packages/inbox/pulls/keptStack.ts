/**
 * What is open stays open (the owner, 2026-11-23: "If I'm ever in a thread, if I ever create a thread for any PR … it
 * should never disappear on me no matter what"). A PR's page, its diff and a stack's page hold the last stack they
 * drew when the list stops naming it: someone merged or closed it, a read came back without it (a forge or `gh`
 * blip), or another window's view left it out. The page keeps everything it had; only what the latest list says of
 * each layer comes in (a merged PR is still in the raw list for a while: its page's state mark turns merged, the mark
 * the PR gets everywhere else). A PR merely missing from the latest read shows nothing new: it just stays.
 *
 * Not held: another stack or PR (the address moved on), one the person hid (in `hidden` / `hidden_repos`, from any
 * window). Closing the page is the person's: its Back, or Hide here.
 */
import { useRef } from 'react';
import { inboxPullRepoOfKey, type InboxPull, type InboxPullsAnswer, type InboxPullStack } from '@plannotator/core/inbox-types';

/** The stack with each layer as the list now has it, where the list still names it. */
export function restack(stack: InboxPullStack, pulls: readonly InboxPull[]): InboxPullStack {
  const now = new Map(pulls.map((p) => [p.key, p]));
  if (!stack.layers.some((l) => now.has(l.key) && now.get(l.key) !== l)) return stack;
  return { ...stack, layers: stack.layers.map((l) => now.get(l.key) ?? l) };
}

/** The person hid one of its layers, or its repository. */
export function hiddenIn(stack: InboxPullStack, model: Pick<InboxPullsAnswer, 'hidden' | 'hidden_repos'>): boolean {
  const keys = new Set((model.hidden ?? []).map((h) => h.key));
  const repos = new Set((model.hidden_repos ?? []).map((r) => r.key));
  return stack.layers.some((l) => keys.has(l.key) || repos.has(inboxPullRepoOfKey(l.key)));
}

export interface KeptStack<T> {
  /** What the page asked for: a stack id, or a stack id and a layer. */
  id: string;
  value: T;
}

/** The value to draw: the live one, else the one held for this same `id` with its layers as the list has them now. */
export function keptStackValue<T extends { stack: InboxPullStack } | InboxPullStack>(
  found: T | null,
  held: KeptStack<T> | null,
  id: string,
  model: Pick<InboxPullsAnswer, 'pulls' | 'hidden' | 'hidden_repos'> | null | undefined,
): T | null {
  if (found) return found;
  if (!held || held.id !== id || !model) return null;
  const value: { stack: InboxPullStack } | InboxPullStack = held.value;
  const stack = 'layers' in value ? value : value.stack;
  if (hiddenIn(stack, model)) return null;
  const now = restack(stack, model.pulls);
  if (now === stack) return held.value;
  return ('layers' in value ? now : { ...value, stack: now }) as T;
}

/** The stacks pages drew last (the last few): a layer opened from a held stack's page opens on that stack. */
const DRAWN = new Map<string, InboxPullStack>();
const DRAWN_MAX = 20;

/** The stack a page drew last that the address names (its id or a layer's key) and that holds this layer. */
export function drawnStackWith(stackId: string, layerKey: string, model: Pick<InboxPullsAnswer, 'pulls' | 'hidden' | 'hidden_repos'> | null | undefined): InboxPullStack | null {
  if (!model) return null;
  for (const stack of [...DRAWN.values()].reverse()) {
    if (!stack.layers.some((l) => l.key === layerKey) || (stack.id !== stackId && !stack.layers.some((l) => l.key === stackId))) continue;
    return hiddenIn(stack, model) ? null : restack(stack, model.pulls);
  }
  return null;
}

/** `keptStackValue` across renders: one page's hold, forgotten when its `id` changes. */
export function useKeptStack<T extends { stack: InboxPullStack } | InboxPullStack>(
  found: T | null,
  id: string | null,
  model: Pick<InboxPullsAnswer, 'pulls' | 'hidden' | 'hidden_repos'> | null | undefined,
): T | null {
  const held = useRef<KeptStack<T> | null>(null);
  const value = id ? keptStackValue(found, held.current, id, model) : null;
  held.current = value && id ? { id, value } : null;
  if (value) {
    const drawn: { stack: InboxPullStack } | InboxPullStack = value;
    const stack = 'layers' in drawn ? drawn : drawn.stack;
    DRAWN.delete(stack.id);
    DRAWN.set(stack.id, stack);
    while (DRAWN.size > DRAWN_MAX) DRAWN.delete(DRAWN.keys().next().value!);
  }
  return value;
}
