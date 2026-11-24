/**
 * What an action on a PR the list does not name answers (start or own its thread, post a review, merge, close): one
 * kept since it left the list (merged or closed elsewhere: `InboxPulls.held`) is no longer open, `409 pull_closed`, so
 * the page that is still open on it says that, never "not in the list"; any other is `404 pull_unknown`.
 */
import type { InboxPull } from "@plannotator/core/inbox-types";

export type PullMissingAnswer = [{ error: string; code: "pull_closed" | "pull_unknown" }, 409 | 404];

export function pullMissingAnswer(pulls: { held(key: string): InboxPull | null }, key: string): PullMissingAnswer {
  return pulls.held(key)
    ? [{ error: "That pull request is no longer open.", code: "pull_closed" }, 409]
    : [{ error: "That pull request is not in the list. Refresh the list and try again.", code: "pull_unknown" }, 404];
}
