/**
 * Plannotator for DeepSeek Harness (DSH): a Host plugin that opens DSH's plan
 * review (`exit_plan_mode`) in Plannotator. See plan-review.ts.
 *
 * Code review, annotate and annotate-last need no plugin: Plannotator's shared
 * skills in ~/.agents/skills run `plannotator review|annotate|last` from a DSH
 * shell, and the CLI detects DSH there from DSH_SHELL.
 *
 * Exports the Cordis plugin object shape (`name` + `apply`); nothing else is
 * exported here, because the loader reads this module's exports as the plugin.
 */

import { createPlanReviewListener, resolveConfig, type DshContext } from "./plan-review";

export const name = "plannotator";

export function apply(ctx: DshContext, config?: unknown): void {
  const resolved = resolveConfig(config);
  if (!resolved.planReview) return;
  // Unloading the plugin closes a review that is still open: Cordis removes
  // the listener but does not abort a waterfall that is already running.
  const unload = new AbortController();
  ctx.effect?.(() => () => unload.abort(new Error("@plannotator/dsh was unloaded")));
  // Prepended: DSH's own Web answerer registers per client stream, and
  // listeners run in registration order.
  ctx.on("user-questions/request", createPlanReviewListener(ctx, resolved, { unloadSignal: unload.signal }), { prepend: true });
}
