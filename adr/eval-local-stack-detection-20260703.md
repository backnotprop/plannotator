# Evaluation: local stack-parent detection (NOT a commitment to build)

Status: evaluation only. Decision pending. Written after empirically stress-
testing the candidate algorithm in scratch repos and against this repo itself
(feat/commit-list stacked on feat/simple-git, 35 local branches of noise).

## The question

PR review mode gets stack awareness from the platform's *declared* base
branch (pr-stack.ts). A local session has no declared base — git does not
store "branch X was created from branch Y" anywhere durable. Can we detect
the stack parent locally, reliably enough to act on?

## Candidate algorithm ("merge-base reachability")

For current branch B with default base D (origin/main):

- For every other branch P: `mb = merge-base(B, P)`.
  **P qualifies iff `mb` is NOT an ancestor of D** — i.e. B's history
  contains commits that exist on P but not on D. This is the graph-true
  definition of "builds on P's unique work".
- Pick the qualifier with the deepest `mb` (most commits past D);
  tie-break by smallest tip distance (`mb..P` count).

## Scenario matrix (all run as real repos, harness in session scratchpad)

| # | Scenario | Result | Verdict |
|---|----------|--------|---------|
| S1 | Clean stack (parent has commits) | parent | ✅ |
| S2 | "Stack" where parent never got commits | none → main | ✅ correct — there IS no stack in the graph |
| S3 | Parent advanced after fork | parent | ✅ |
| S4 | Parent rebased after fork (evidence rewritten) | none → main | ✅ honest degrade — B no longer builds on P's current commits |
| S5 | Sibling stacked at same fork point | parent (tipdist 0 beats sibling) | ✅ |
| S5b | Sibling(+1) vs advanced parent(+3) | **sibling** | ❌ label wrong — but see safety property below |
| S6 | Checkpoint branch pointing INSIDE B's history | **checkpoint** | ❌ **dangerous** |
| S6b | Branch created FROM B, with own commits | **child** | ❌ **dangerous** |
| S7 | Parent already merged into main | none → main | ✅ |
| S8 | Two-level stack (B on P2 on P1) | P2 | ✅ deepest-mb picks the immediate parent |

Real-repo run (this worktree, 35 branches incl. worktree-*/review/* noise):
qualifiers were exactly `feat/simple-git` (depth 13, tipdist 0 — correct) and
`feat/guided-review` (depth 7 — a mid-lineage pointer, filtered by depth).
Right answer, and live proof that mid-lineage pointer branches exist in
practice.

## The two failure classes are NOT equally bad

**S5b (wrong label, same merge-base) is content-harmless.** Every review
surface keys off `merge-base(base, HEAD)` — the since-base diff, the sections
partition, and the commits-panel boundary. Qualifiers at the same fork point
have the *same* merge-base, so picking the wrong sibling produces a
byte-identical review; only the label lies. Verified: S5/S5b mbs are equal.

**S6/S6b (child-branch trap) silently hides work.** A branch pointing inside
B's own history (checkpoint, review/*, a branch someone cut from B) wins on
depth, and its merge-base lands *inside B* — the review then excludes B's own
earlier commits with no error and no visual tell. This is the
fuck-things-up case.

**And it is provably undetectable by graph queries alone.** "X was created
from B at commit M" and "B was created from X at M" produce identical graphs;
arrows carry no history. Reflogs don't rescue it: the common creation path
(`git checkout -b` while standing on the parent) records `branch: Created
from HEAD` — no parent name (verified empirically). Reflogs are also
local-only and expire.

## Determination

- The **stacked-ness test** is deterministic and never lied in any scenario:
  "does B build on commits not in D, and which fork commit" is graph truth.
  S2/S4/S7 all correctly report *no stack*.
- The **parent attribution** is a heuristic with one harmless failure mode
  (same-mb label, S5b) and one dangerous one (child trap, S6) that cannot be
  eliminated, only mitigated.

Therefore, if built, the only responsible shape is:

1. **Suggest, never auto-apply.** On session start in a local git review,
   when qualifiers exist: "This branch looks stacked on `feat/simple-git` —
   compare against it?" One click applies it via the existing base-switch
   path. The suggestion must show the consequence in numbers ("review the 7
   commits above it") — a child-trap mis-suggestion is then self-evident,
   because the count visibly swallows the user's own commits.
2. **Persist the user's explicit choice per repo+branch** (config.json), which
   makes every later session deterministic — the detection only ever runs to
   *offer*, never to decide. Store a ref name, never a sha (rebase-safe),
   same rule the commits view already follows.
3. **Show all qualifiers** in the affordance (there were 2 in the real repo),
   not a single confident answer.

## Explicitly rejected

- Silent auto-defaulting to the detected parent (S6 makes this unacceptable).
- Reflog-based detection (Created-from-HEAD gap; local-only; expiring).
- Trusting tip-distance tie-breaks for anything beyond ordering a suggestion
  list (S5b).

## Open questions before any build

- Should remote-only branches (origin/*) be candidates? (Teammate stacks
  cloned fresh have no local parent branch.)
- Cache/refresh policy: qualifiers change on every fetch/rebase; suggestion
  should recompute per session, persisted choice should win silently.
- Interaction with the PR flow: once a PR exists, the platform's declared
  base should supersede any local inference.
