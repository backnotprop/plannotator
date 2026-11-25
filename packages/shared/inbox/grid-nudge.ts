/**
 * The words a nudge sends (approval "inbox-agent-grid", round 4, NUDGE-WORDS.md; owner-approved 2026-11-25): the
 * first sentence filled from the line (its name, how long it has been quiet, and one detail when there is one), the
 * second always the same. The nudge is an ordinary reply from the person: these words are its body, as stored and
 * shown, and what the agent reads. Nothing else tells an agent about Grid. Pure.
 *
 *   "Haptics on save has been quiet for 3 h 37 min, with tests failing on #22. Please finish it, or tell me in a few
 *    words why it stopped."
 */
import { gridExact, type GridLine } from "./grid";

/** The second sentence, every time. Approved word for word: do not change a character. */
export const GRID_NUDGE_ASK = "Please finish it, or tell me in a few words why it stopped.";

/**
 * A stale line's nudge at `now`. `at` says a time as the line says it ("8:05 PM"). The detail, from what the line
 * already shows: a PR's failing tests, a draft PR, or a plan never started. Failing tests say "since 8:05 PM" only
 * when the thread's computer saw them start failing (`detail.since`, the PR's `checks_at`); otherwise no time.
 *
 * The forms: "<name> has been quiet for <D>." with nothing, ", with tests failing on #22 since 8:05 PM",
 * ", with tests failing on #22", ", with tests failing", ", with #7 still a draft", ", planned at 7:20 PM and not
 * started"; then GRID_NUDGE_ASK. <D> is exact ("3 h 37 min", "1 d 6 h").
 */
export function gridNudgeWords(line: Pick<GridLine, "name" | "staleFrom" | "planned" | "detail">, now: number, at: (ms: number) => string): string {
  const from = line.staleFrom ?? now;
  let detail = "";
  if (line.planned !== null) detail = `, planned at ${at(line.planned)} and not started`;
  else if (line.detail?.words === "tests failing") {
    const since = line.detail.since ?? null;
    detail = `, with tests failing${line.detail.pr ? ` on ${line.detail.pr}` : ""}${since !== null ? ` since ${at(since)}` : ""}`;
  }
  // A draft is named by its PR ("with #7 still a draft"); one with no label says no detail (approved forms only).
  else if (line.detail?.words === "draft" && line.detail.pr) detail = `, with ${line.detail.pr} still a draft`;
  return `${line.name} has been quiet for ${gridExact(now - from, true)}${detail}. ${GRID_NUDGE_ASK}`;
}
