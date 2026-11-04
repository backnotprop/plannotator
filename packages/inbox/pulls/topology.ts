/**
 * A stack's shape and who owns which layer, read from core's tree (`InboxPullStack.parents`, the one source of it):
 * what lands next, what each layer sits on, the next layer up, and which agent's thread a verdict on a layer (or on
 * the stack up to it) goes to. Never from the layers' order in the list: a fork's second branch comes after the
 * first's upper layers there.
 */
import {
  inboxPullAncestors,
  inboxPullLabel,
  inboxPullLandsNext,
  inboxPullParent,
  type InboxPull,
  type InboxPullLink,
  type InboxPullStack,
} from '@plannotator/core/inbox-types';

type Links = Readonly<Record<string, InboxPullLink>>;

export const isOpen = (pull: Pick<InboxPull, 'state'>) => pull.state === 'open' || pull.state === 'draft';

/** The open layer a layer sits on, through merged layers between; null on none. */
function openUnder(stack: InboxPullStack, key: string): InboxPull | null {
  return inboxPullAncestors(stack, key).find(isOpen) ?? null;
}

/** The layer after this one in landing order: the first open layer that sits on it (a fork's sibling is not next); null at the top. */
export function nextLayer(stack: InboxPullStack, key: string): InboxPull | null {
  return stack.layers.find((l) => isOpen(l) && l.key !== key && openUnder(stack, l.key)?.key === key) ?? null;
}

/**
 * "Layer N of M" for an open layer, on its own line of the stack: N counts the open layers it sits on (through merged
 * ones) and itself; M adds the longest line of open layers above it. In a fork each branch counts only its own
 * layers, never a sibling's. Null for a layer that is not open.
 */
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

/** Where "Open the diff" starts (layer by layer): the next layer to land that is not a draft, else the next to land. */
export function startLayer(stack: InboxPullStack): InboxPull | null {
  const open = stack.layers.filter(isOpen);
  return open.find((l) => l.state === 'open') ?? open[0] ?? null;
}

/** The layer marked "Lands next": the lowest open one, only in a stack of several open layers. */
export function landsNextLayer(stack: InboxPullStack): InboxPull | null {
  const next = inboxPullLandsNext(stack);
  return next && stack.layers.filter(isOpen).length >= 2 ? next : null;
}

/**
 * "After #412" (it sits on an open layer), "Also on #9101" (a second layer on the same one: the stack forks there),
 * "On #411, merged", "Based on main" (the next to land, in a stack), "Based on dr/route53" (the next to land, alone,
 * on a branch that is not its repository's default one, when the forge said which that is), or null. Nothing is said
 * of a base no PR the Inbox read has as its head: its PR may be a teammate's the searches did not return.
 */
export function layerBaseWords(pull: InboxPull, stack: InboxPullStack): string | null {
  const under = inboxPullParent(stack, pull.key);
  if (under && isOpen(under)) {
    // Siblings by number: the first is "After", every other one "Also on" (a fork, not a chain).
    const first = stack.layers.find((l) => isOpen(l) && stack.parents[l.key] === under.key);
    return first && first.key !== pull.key ? `Also on ${inboxPullLabel(under)}` : `After ${inboxPullLabel(under)}`;
  }
  if (under) return `On ${inboxPullLabel(under)}, merged`;
  if (!isOpen(pull) || inboxPullLandsNext(stack)?.key !== pull.key) return null;
  if (stack.layers.length > 1) return `Based on ${pull.base}`;
  return pull.default_branch && pull.base !== pull.default_branch ? `Based on ${pull.base}` : null;
}

/** A row's chain of marks: every layer up to five; past that the first two, "+N", and the last two. */
export function chainMarks(layers: readonly InboxPull[]): (InboxPull | { more: number })[] {
  if (layers.length <= 5) return [...layers];
  return [layers[0]!, layers[1]!, { more: layers.length - 4 }, layers[layers.length - 2]!, layers[layers.length - 1]!];
}

/**
 * The agent's thread behind a stack: the lowest open layer's link (the agent that opened the stack from its
 * bottom), else any layer's. An agent that linked one layer higher up is that layer's agent, not the stack's.
 */
export function stackLink(stack: InboxPullStack, links: Links): InboxPullLink | null {
  for (const layer of stack.layers) if (isOpen(layer) && links[layer.key]) return links[layer.key]!;
  return stack.layers.map((l) => links[l.key]).find((l): l is InboxPullLink => !!l) ?? null;
}

/**
 * Where a verdict on one layer goes: that layer's own agent thread; else the thread of the nearest linked layer it
 * sits on (down its own line of the stack, never a sibling's); else, when only one thread links the stack, that one.
 * With several agents on one stack, each gets verdicts only for its own layers and the ones above them. Among the
 * person's own open layers only; null for a teammate's PR, which never takes a verdict here (the person reviews it
 * on the forge).
 */
export function layerVerdictLink(layer: InboxPull, stack: InboxPullStack, links: Links): InboxPullLink | null {
  if (!layer.mine) return null;
  if (links[layer.key]) return links[layer.key]!;
  const owned = (l: InboxPull) => l.mine && isOpen(l) && !!links[l.key];
  const below = inboxPullAncestors(stack, layer.key).find(owned);
  if (below) return links[below.key]!;
  const linked = stack.layers.filter(owned);
  const threads = new Set(linked.map((l) => links[l.key]!.thread_id));
  return threads.size === 1 ? links[linked[0]!.key]! : null;
}

/**
 * Where a "Whole stack" verdict up to a layer goes: the compare covers that layer and the open layers it sits on, so
 * the verdict goes to an agent only when every one of the person's layers in it is that agent's (a layer of no agent
 * goes with it). Several agents: `agents` names them and `link` is null (no agent takes a verdict on another's
 * layers; posting to the forge still can).
 */
export function stackVerdictLink(layer: InboxPull, stack: InboxPullStack, links: Links): { link: InboxPullLink | null; agents: InboxPullLink[] } {
  const own = layerVerdictLink(layer, stack, links);
  if (!own) return { link: null, agents: [] };
  // Bottom first: the agents are named in landing order.
  const range = [...inboxPullAncestors(stack, layer.key).filter(isOpen).reverse(), layer];
  const byThread = new Map<string, InboxPullLink>();
  for (const l of range) {
    const link = layerVerdictLink(l, stack, links);
    if (link) byThread.set(link.thread_id, link);
  }
  return byThread.size > 1 ? { link: null, agents: [...byThread.values()] } : { link: own, agents: [own] };
}

/**
 * Why a "Whole stack" verdict cannot go to an agent (`stackVerdictLink` found several): "Claude Code and Codex each
 * have layers here. Send to an agent from This layer." Agents of one name are counted ("2 Claude Code threads").
 */
export function stackAgentsWords(names: readonly string[]): string {
  const distinct = [...new Set(names)];
  const who =
    distinct.length === 1
      ? `${names.length} ${distinct[0]} threads`
      : distinct.length === 2
        ? `${distinct[0]} and ${distinct[1]}`
        : `${distinct.slice(0, -1).join(', ')} and ${distinct[distinct.length - 1]}`;
  return `${who} each have layers here. Send to an agent from This layer.`;
}

/** The agents with a layer of the stack other than the stack's own (`stackLink`): one entry per thread. */
export function otherLayerAgents(stack: InboxPullStack, links: Links): { link: InboxPullLink; layers: InboxPull[] }[] {
  const main = stackLink(stack, links);
  const out = new Map<string, { link: InboxPullLink; layers: InboxPull[] }>();
  for (const layer of stack.layers) {
    if (!isOpen(layer)) continue;
    const link = layerVerdictLink(layer, stack, links);
    if (!link || link.thread_id === main?.thread_id) continue;
    const entry = out.get(link.thread_id) ?? { link, layers: [] };
    entry.layers.push(layer);
    out.set(link.thread_id, entry);
  }
  return [...out.values()];
}
