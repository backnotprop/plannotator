/**
 * What an action on a PR the list does not name acts on (start or own its thread, post a review, merge, close). A
 * copy kept since it left the list (`InboxPulls.held`, every forge read of `pull()` too) that is still open is acted
 * on: an open PR that briefly left the list (a search that came back without it) is still the person's to act on,
 * and the forge is asked again by the action itself. One whose kept copy is merged or closed is no longer open,
 * `409 pull_closed`, so the page still open on it says that, never "not in the list"; any other is `404 pull_unknown`.
 * A review or comment from a kept copy asks the forge first (`pullToActNow`).
 */
import { inboxPullIsOpen, type InboxPull } from "@plannotator/core/inbox-types";

export type PullMissingAnswer = [{ error: string; code: "pull_closed" | "pull_unknown" }, 409 | 404];

type Pulls = { find(key: string): InboxPull | null; held(key: string): InboxPull | null };

/** The PR an action takes: the list's, else a kept copy that is still open; null when there is none to act on. */
export function pullToAct(pulls: Pulls, key: string): InboxPull | null {
  const listed = pulls.find(key);
  if (listed) return listed;
  const held = pulls.held(key);
  return held && inboxPullIsOpen(held) ? held : null;
}

/**
 * `pullToAct` for a write the forge would take on a closed PR too (a review, a comment): a kept copy is only as new as
 * its last read, and a PR merged elsewhere since would take the review. The forge is asked now first; merged or closed
 * there, none (`pullMissingAnswer` then says `pull_closed`, and the page's next read says which, from this read). The
 * forge not answering, or not knowing the PR, says nothing new: the kept copy, and the write fails as it would.
 */
export async function pullToActNow(pulls: Pulls & { pull(key: string, repos?: undefined, ask?: { fresh?: boolean }): Promise<{ pull: InboxPull | null; unreadable?: true; missing?: true }> }, key: string): Promise<InboxPull | null> {
  const listed = pulls.find(key);
  if (listed) return listed;
  if (!pullToAct(pulls, key)) return null;
  const now = await pulls.pull(key, undefined, { fresh: true });
  if (now.pull && !now.unreadable && !now.missing && !inboxPullIsOpen(now.pull)) return null;
  return pullToAct(pulls, key);
}

export function pullMissingAnswer(pulls: Pick<Pulls, "held">, key: string): PullMissingAnswer {
  const held = pulls.held(key);
  return held && !inboxPullIsOpen(held)
    ? [{ error: "That pull request is no longer open.", code: "pull_closed" }, 409]
    : [{ error: "That pull request is not in the list. Refresh the list and try again.", code: "pull_unknown" }, 404];
}
