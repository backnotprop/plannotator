/**
 * Plannotator for DeepSeek Harness (DSH): a Host plugin that opens DSH's plan
 * review (`exit_plan_mode`) in Plannotator (plan-review.ts), and connects DSH
 * sessions to the Plannotator Inbox (inbox.ts): the `plannotator_inbox` tool,
 * and the person's replies going back into the session as a turn.
 *
 * Code review, annotate and annotate-last need no plugin: Plannotator's shared
 * skills in ~/.agents/skills run `plannotator review|annotate|last` from a DSH
 * shell, and the CLI detects DSH there from DSH_SHELL.
 *
 * Exports the Cordis plugin object shape (`name` + `apply`); nothing else is
 * exported here, because the loader reads this module's exports as the plugin.
 */

import { setupDshInbox, type DshInbox, type DshInboxContext } from "./inbox";
import { createPlanReviewListener, resolveConfig, type DshContext } from "./plan-review";

export const name = "plannotator";

/**
 * Registers plan review at once. The Inbox connection is decided at load
 * (its switch, the Inbox's registry) and set up once the Inbox's tools are
 * known, at most about 2 s; the returned promise settles then and never
 * rejects, so a DSH that awaits a plugin's setup has the tool before its
 * first session request.
 */
export function apply(ctx: DshContext, config?: unknown): Promise<void> {
  const resolved = resolveConfig(config);
  // Unloading the plugin closes a review that is still open (Cordis removes
  // the listener but does not abort a waterfall that is already running) and
  // stops every Inbox wake.
  const unload = new AbortController();
  ctx.effect?.(() => () => unload.abort(new Error("@plannotator/dsh was unloaded")));
  if (resolved.planReview) {
    // Prepended: DSH's own Web answerer registers per client stream, and
    // listeners run in registration order.
    ctx.on("user-questions/request", createPlanReviewListener(ctx, resolved, { unloadSignal: unload.signal }), { prepend: true });
  }
  let inbox: DshInbox | null = null;
  unload.signal.addEventListener("abort", () => inbox?.dispose(), { once: true });
  return setupDshInbox(ctx as unknown as DshInboxContext, { unloadSignal: unload.signal })
    .then((started) => {
      if (unload.signal.aborted) started?.dispose();
      else inbox = started;
    })
    .catch((error: unknown) => {
      try {
        ctx.logger?.warn?.("plannotator: the Plannotator Inbox connection did not start (%s)", error instanceof Error ? error.message : String(error));
      } catch {
        // Logging is best-effort.
      }
    });
}
