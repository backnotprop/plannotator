/** A stack's shape from core's tree, never from the layers' order in the list: a fork's second branch comes after the first's upper layers there. */
import {
  inboxPullAncestors,
  inboxPullIsOpen,
  inboxPullLabel,
  inboxPullLandsNext,
  inboxPullParent,
  type InboxPull,
  type InboxPullLink,
  type InboxPullStack,
} from '@plannotator/core/inbox-types';

type Links = Readonly<Record<string, InboxPullLink>>;

export const isOpen = inboxPullIsOpen;

function openUnder(stack: InboxPullStack, key: string): InboxPull | null {
  return inboxPullAncestors(stack, key).find(isOpen) ?? null;
}

export function nextLayer(stack: InboxPullStack, key: string): InboxPull | null {
  return stack.layers.find((l) => isOpen(l) && l.key !== key && openUnder(stack, l.key)?.key === key) ?? null;
}

export function layerPosition(stack: InboxPullStack, key: string): { at: number; of: number } | null {
  const layer = stack.layers.find((l) => l.key === key);
  if (!layer || !isOpen(layer)) return null;
  const at = inboxPullAncestors(stack, key).filter(isOpen).length + 1;
  // Core's tree has no cycles; `seen` only keeps a bad one from looping.
  const above = (from: string, seen: Set<string>): number => {
    let most = 0;
    for (const l of stack.layers) {
      if (!isOpen(l) || seen.has(l.key) || openUnder(stack, l.key)?.key !== from) continue;
      most = Math.max(most, 1 + above(l.key, new Set(seen).add(l.key)));
    }
    return most;
  };
  return { at, of: at + above(key, new Set([key])) };
}

export function startLayer(stack: InboxPullStack): InboxPull | null {
  const open = stack.layers.filter(isOpen);
  return open.find((l) => l.state === 'open') ?? open[0] ?? null;
}

export function landsNextLayer(stack: InboxPullStack): InboxPull | null {
  const next = inboxPullLandsNext(stack);
  return next && stack.layers.filter(isOpen).length >= 2 ? next : null;
}

export function layerBaseWords(pull: InboxPull, stack: InboxPullStack): string | null {
  const under = inboxPullParent(stack, pull.key);
  if (under && isOpen(under)) {
    const first = stack.layers.find((l) => isOpen(l) && stack.parents[l.key] === under.key);
    return first && first.key !== pull.key ? `Also on ${inboxPullLabel(under)}` : `After ${inboxPullLabel(under)}`;
  }
  if (under) return `On ${inboxPullLabel(under)}, merged`;
  if (!isOpen(pull) || inboxPullLandsNext(stack)?.key !== pull.key) return null;
  if (stack.layers.length > 1) return `Based on ${pull.base}`;
  return pull.default_branch && pull.base !== pull.default_branch ? `Based on ${pull.base}` : null;
}

export function chainMarks(layers: readonly InboxPull[]): (InboxPull | { more: number })[] {
  if (layers.length <= 5) return [...layers];
  return [layers[0]!, layers[1]!, { more: layers.length - 4 }, layers[layers.length - 2]!, layers[layers.length - 1]!];
}

export function stackLink(stack: InboxPullStack, links: Links): InboxPullLink | null {
  for (const layer of stack.layers) if (isOpen(layer) && links[layer.key]) return links[layer.key]!;
  return stack.layers.map((l) => links[l.key]).find((l): l is InboxPullLink => !!l) ?? null;
}

export function layerVerdictLink(layer: InboxPull, stack: InboxPullStack, links: Links): InboxPullLink | null {
  if (!layer.mine) return null;
  if (links[layer.key]) return links[layer.key]!;
  const onLine = (l: InboxPull) =>
    inboxPullAncestors(stack, layer.key).some((a) => a.key === l.key) || inboxPullAncestors(stack, l.key).some((a) => a.key === layer.key);
  const offBranch = (thread: string) =>
    isOpen(layer) && stack.layers.some((l) => l.key !== layer.key && isOpen(l) && links[l.key]?.thread_id === thread && !onLine(l));
  const owned = (l: InboxPull) => l.mine && isOpen(l) && !!links[l.key] && !offBranch(links[l.key]!.thread_id);
  const below = inboxPullAncestors(stack, layer.key).find(owned);
  if (below) return links[below.key]!;
  const linked = stack.layers.filter(owned);
  const threads = new Set(linked.map((l) => links[l.key]!.thread_id));
  return threads.size === 1 ? links[linked[0]!.key]! : null;
}

export function stackVerdictLink(layer: InboxPull, stack: InboxPullStack, links: Links): InboxPullLink | null {
  if (!layer.mine) return null;
  const owned = stack.layers.find((l) => l.mine && isOpen(l) && !!links[l.key]);
  return (owned ? links[owned.key]! : null) ?? layerVerdictLink(layer, stack, links);
}
