import type { PRListItem } from "../../daemon/contracts";

export interface PRStack {
  prs: PRListItem[];
  label: string;
}

/**
 * Group PRs into "stacks" — chains where each PR's base branch is the previous
 * PR's head branch (rather than the repo default branch).
 *
 * Each chain is rooted at a *leaf* (a PR whose head branch is not any other
 * PR's base branch) and walked downward toward its base, following
 * `baseBranch → headBranch` edges. Rooting from leaves captures the full chain
 * in a single pass, so the grouping is independent of the order PRs arrive in.
 *
 * Determinism is total — every output is independent of input array order:
 *  - Candidate leaves are processed in ascending PR `number` order.
 *  - `byHead` collisions (two PRs on the same head branch) resolve to the open
 *    PR, then to the lower PR `number`.
 *  - The returned `stacks` (by base PR `number`) and `loose` (by `number`) are
 *    sorted before returning.
 *
 * Forks (two PRs sharing a base) are handled deterministically rather than
 * merged: the shared ancestor joins exactly one chain — the one rooted at the
 * lowest-numbered leaf — and the sibling leaf(s) fall through to `loose`. This
 * is a deliberate "one child wins, the rest are loose" policy, not full fork
 * collapse, but the *choice* of which child wins is now order-independent.
 *
 * Output shape:
 *  - `stacks`: chains of length > 1, ordered base → leaf, labelled
 *    `#<first> → #<last>`, sorted by the base PR's `number`.
 *  - `loose`: every PR not part of a multi-PR stack, sorted by `number`.
 *
 * The base PR of a stack (whose base is the default branch) is included in the
 * stack via the walk. Single non-default-based PRs with no parent in the set,
 * and cycles, fall through to `loose`.
 */
export function buildStacks(prs: PRListItem[]): {
  stacks: PRStack[];
  loose: PRListItem[];
} {
  // headBranch → PR, so we can follow a PR's baseBranch to its parent PR. When
  // two PRs share a head branch (e.g. `state=all` returns a merged + an open PR
  // on the same branch), keep a deterministic winner — prefer the open PR, then
  // the lower PR number — so chain-following does not depend on input order.
  const byHead = new Map<string, PRListItem>();
  for (const pr of prs) {
    const existing = byHead.get(pr.headBranch);
    if (!existing || preferHead(pr, existing)) byHead.set(pr.headBranch, pr);
  }

  // Every branch that some PR is based on. A PR is a leaf when its head branch
  // is not in this set — i.e. nothing in the set is stacked on top of it.
  const baseBranches = new Set<string>();
  for (const pr of prs) baseBranches.add(pr.baseBranch);

  const stacked = new Set<string>();
  const chains: PRListItem[][] = [];

  // Root each chain from a leaf and walk down toward its base. Leaves are
  // visited in ascending PR-number order so that when two leaves share an
  // ancestor (a fork), the lowest-numbered leaf deterministically claims it.
  const leaves = prs
    .filter((pr) => !baseBranches.has(pr.headBranch))
    .sort((a, b) => a.number - b.number);

  for (const leaf of leaves) {
    if (stacked.has(leaf.id)) continue;

    const chain: PRListItem[] = [];
    let current: PRListItem | undefined = leaf;
    while (current && !stacked.has(current.id)) {
      chain.unshift(current);
      stacked.add(current.id);
      current = byHead.get(current.baseBranch);
    }

    if (chain.length > 1) {
      chains.push(chain);
    } else {
      // A lone PR (no parent in the set, or whose ancestor was already claimed
      // by a lower-numbered fork sibling) is not a stack — release it so it
      // surfaces as loose, matching single-chain behaviour.
      stacked.delete(chain[0].id);
    }
  }

  const stacks = chains
    .map((chain) => ({
      prs: chain,
      label: `#${chain[0].number} → #${chain[chain.length - 1].number}`,
    }))
    .sort((a, b) => a.prs[0].number - b.prs[0].number);
  const loose = prs
    .filter((pr) => !stacked.has(pr.id))
    .sort((a, b) => a.number - b.number);
  return { stacks, loose };
}

/** True when `candidate` should win a head-branch collision over `existing`. */
function preferHead(candidate: PRListItem, existing: PRListItem): boolean {
  const candidateOpen = candidate.state === "open";
  const existingOpen = existing.state === "open";
  if (candidateOpen !== existingOpen) return candidateOpen;
  return candidate.number < existing.number;
}
