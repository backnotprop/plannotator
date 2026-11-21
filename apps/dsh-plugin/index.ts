/**
 * Plannotator for DeepSeek Harness (DSH): a Host plugin that opens DSH's plan
 * review (`exit_plan_mode`) in Plannotator (plan-review.ts), and connects DSH
 * sessions to the Plannotator Inbox (inbox.ts): the `plannotator_inbox` tool,
 * and the person's replies going back into the session as a turn.
 *
 * Code review, annotate and annotate-last (tool.ts, reviews.ts): the
 * `plannotator` agent tool (off by default) and the `/plannotator-review`,
 * `/plannotator-annotate` and `/plannotator-last` commands open the review and
 * return at once; the decision arrives later as a new turn. The shared skills
 * in ~/.agents/skills still work from a DSH shell.
 *
 * Exports the Cordis plugin object shape (`name` + `apply`); nothing else is
 * exported here, because the loader reads this module's exports as the plugin.
 * The body is plugin.ts.
 */

import type { DshInboxContext } from "./inbox";
import type { DshContext } from "./plan-review";
import { applyPlannotator } from "./plugin";

export const name = "plannotator";

/** Plan review at once; the Inbox connection once DSH's agents and tools are active (plugin.ts). Never rejects. */
export function apply(ctx: DshContext & Partial<Pick<DshInboxContext, "inject">>, config?: unknown): Promise<void> {
  return applyPlannotator(ctx, config);
}
