/**
 * What an action on a PR the list does not name acts on (start or own its thread, post a review, merge, close). A
 * copy kept since it left the list (`InboxPulls.held`, every forge read of `pull()` too) that is still open is acted
 * on: an open PR that briefly left the list (a search that came back without it) is still the person's to act on,
 * and the forge is asked again by the action itself. One whose kept copy is merged or closed is no longer open,
 * `409 pull_closed`, so the page still open on it says that, never "not in the list"; any other is `404 pull_unknown`.
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

export function pullMissingAnswer(pulls: Pick<Pulls, "held">, key: string): PullMissingAnswer {
  const held = pulls.held(key);
  return held && !inboxPullIsOpen(held)
    ? [{ error: "That pull request is no longer open.", code: "pull_closed" }, 409]
    : [{ error: "That pull request is not in the list. Refresh the list and try again.", code: "pull_unknown" }, 404];
}
