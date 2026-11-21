/**
 * New review's pasted Forgejo / Gitea link: the one PR read, with the person's token for that host (never a CLI), as
 * the Inbox's `InboxPull` so Start hands it to an agent as it does a GitHub or GitLab link. Only what the hover card
 * reads is known: whose it is and who was asked are not, so it is not "mine" and not "requested".
 */
import type { ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import { inboxPullUrlOf, type InboxPull, type InboxPullState } from "@plannotator/core/inbox-types";

const STATES: readonly InboxPullState[] = ["open", "draft", "merged", "closed"];

/** The link's PR, or null when the card is not a pull request (an issue, or a state a PR does not have). */
export function forgejoLinkPull(card: ForgeRefCardData, key: string, host: string): InboxPull | null {
  if (card.kind !== "pull") return null;
  const state = STATES.find((s) => s === card.state);
  if (!state) return null;
  const pull = card.pull;
  const ref = { platform: "forgejo" as const, host, repo: card.repo, number: card.number };
  return {
    key,
    platform: "forgejo",
    host,
    repo: card.repo,
    number: card.number,
    url: inboxPullUrlOf(ref),
    title: card.title,
    author: card.author?.login ?? null,
    mine: false,
    requested: false,
    state,
    base: pull?.base ?? "",
    head: pull?.head ?? "",
    head_repo: null,
    additions: pull?.additions ?? 0,
    deletions: pull?.deletions ?? 0,
    files: pull?.files ?? 0,
    review: pull?.review ?? null,
    approved_by: null,
    reviewers: [],
    checks: pull?.checks?.state === "success" || pull?.checks?.state === "failure" || pull?.checks?.state === "pending" ? pull.checks.state : null,
    updated_at: card.updatedAt,
    merged_at: card.state === "merged" ? card.closedAt : null,
  };
}
