/**
 * Where a PR page's diff runs from (`GET /api/inbox/pulls/diff`, `…/file`): the PR's own base for `layer`, and for the
 * compares (`stack`, `range`, `since`) the refs to try in turn, the first that the forge can compare winning.
 */
import { inboxPullAncestors, inboxPullIsOpen, type InboxPull, type InboxPullDiffScope, type InboxPullStack } from "@plannotator/core/inbox-types";

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The scope and its `from` as the route takes them; null when they do not make one. */
export function pullDiffScopeOf(params: URLSearchParams): { scope: InboxPullDiffScope; from?: string } | null {
  const scope = params.get("scope") ?? "layer";
  const from = params.get("from") ?? "";
  if (scope === "layer" || scope === "stack") return { scope };
  if (scope === "range") return from.length > 0 && from.length <= 600 ? { scope, from } : null;
  if (scope === "since") return SHA.test(from.toLowerCase()) ? { scope, from: from.toLowerCase() } : null;
  return null;
}

/**
 * The refs a diff may run from, in the order tried, or the reason there is none. `range`: the branch its lowest layer
 * (`from`) is based on, then the stack's own base when that branch is gone; `from` must be open and on this layer's own
 * line of the stack, below it. `since`: the commit named.
 */
export function pullDiffBases(stack: InboxPullStack | undefined, pull: InboxPull, scope: InboxPullDiffScope, from?: string): { bases: string[] } | { error: string } {
  if (scope === "layer") return { bases: [pull.base] };
  if (scope === "stack") return { bases: [...new Set([stack?.open_base ?? pull.base, stack?.base ?? pull.base])] };
  if (scope === "since") return from && SHA.test(from) ? { bases: [from] } : { error: "That commit can't be compared here." };
  const first = stack?.layers.find((l) => l.key === from);
  const below = !!first && !!stack && (first.key === pull.key || inboxPullAncestors(stack, pull.key).some((l) => l.key === first.key));
  if (!first || !below || !inboxPullIsOpen(first)) return { error: "Those layers are no longer one open range of this stack." };
  return { bases: [...new Set([first.base, stack!.base])] };
}
