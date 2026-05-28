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
 * Output shape:
 *  - `stacks`: chains of length > 1, ordered base → leaf, labelled
 *    `#<first> → #<last>`.
 *  - `loose`: every PR not part of a multi-PR stack, in original input order.
 *
 * The base PR of a stack (whose base is the default branch) is included in the
 * stack via the walk. Single non-default-based PRs with no parent in the set,
 * and cycles, fall through to `loose`.
 */
export function buildStacks(
  prs: PRListItem[],
  // Retained for signature/call-site compatibility. Leaf-rooting derives chain
  // boundaries from the PR set itself (a base PR based on the default branch
  // simply has no parent in `byHead`), so the default branch is not needed.
  _defaultBranch: string,
): { stacks: PRStack[]; loose: PRListItem[] } {
  // headBranch → PR, so we can follow a PR's baseBranch to its parent PR.
  const byHead = new Map<string, PRListItem>();
  for (const pr of prs) byHead.set(pr.headBranch, pr);

  // Every branch that some PR is based on. A PR is a leaf when its head branch
  // is not in this set — i.e. nothing in the set is stacked on top of it.
  const baseBranches = new Set<string>();
  for (const pr of prs) baseBranches.add(pr.baseBranch);

  const stacked = new Set<string>();
  const chains: PRListItem[][] = [];

  // Root each chain from a leaf and walk down toward its base. Iterating in
  // input order keeps the result stable for a given input.
  for (const leaf of prs) {
    if (baseBranches.has(leaf.headBranch)) continue; // not a leaf
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
      // A lone PR (no parent in the set) is not a stack — release it so it
      // surfaces as loose, matching single-chain behaviour.
      for (const pr of chain) stacked.delete(pr.id);
    }
  }

  const stacks = chains.map((chain) => ({
    prs: chain,
    label: `#${chain[0].number} → #${chain[chain.length - 1].number}`,
  }));
  const loose = prs.filter((pr) => !stacked.has(pr.id));
  return { stacks, loose };
}
