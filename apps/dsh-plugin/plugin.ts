/**
 * The plugin's body, behind `index.ts`'s `apply` (which takes no test hooks):
 * plan review at once, and the Inbox connection once DSH's `agents` and
 * `tools` services are active.
 */

import { setupDshInbox, type DshInbox, type DshInboxContext, type DshInboxDeps } from "./inbox";
import { createPlanReviewListener, resolveConfig, type DshContext } from "./plan-review";

/** The services the Inbox connection needs active before it starts (Cordis `inject`). */
export const DSH_INBOX_SERVICES = ["agents", "tools"];

function warnOf(ctx: DshContext) {
  return (format: string, ...args: unknown[]) => {
    try {
      ctx.logger?.warn?.(format, ...args);
    } catch {
      // Logging is best-effort.
    }
  };
}

/**
 * Start the Inbox connection in `scope` and stop it when `scope` is disposed
 * (the plugin unloads, or a service it was injected with goes away). Never
 * rejects.
 */
function startInbox(scope: DshInboxContext, deps: DshInboxDeps, onStarted?: (inbox: DshInbox | null) => void): Promise<void> {
  const stop = new AbortController();
  scope.effect?.(() => () => stop.abort(new Error("@plannotator/dsh's Inbox connection was stopped")));
  const signal = deps.unloadSignal ? AbortSignal.any([stop.signal, deps.unloadSignal]) : stop.signal;
  let inbox: DshInbox | null = null;
  signal.addEventListener("abort", () => inbox?.dispose(), { once: true });
  return setupDshInbox(scope, { ...deps, unloadSignal: signal })
    .then((started) => {
      if (signal.aborted) started?.dispose();
      else inbox = started;
      onStarted?.(signal.aborted ? null : started);
    })
    .catch((error: unknown) => {
      warnOf(scope as DshContext)("plannotator: the Plannotator Inbox connection did not start (%s)", error instanceof Error ? error.message : String(error));
    });
}

/**
 * Registers plan review at once. The Inbox connection runs in a Cordis
 * `inject(['agents', 'tools'])` child, so a load order where those services
 * become active after this plugin still gets it, and a replaced service
 * restarts it. Where the context has no `inject` (an older or test host), it
 * starts at once. Never rejects; `onInbox` (tests) hears each start.
 */
export function applyPlannotator(
  ctx: DshContext & Partial<Pick<DshInboxContext, "inject">>,
  config?: unknown,
  deps: DshInboxDeps = {},
  onInbox?: (inbox: DshInbox | null) => void,
): Promise<void> {
  const resolved = resolveConfig(config);
  // Unloading the plugin closes a review that is still open (Cordis removes
  // the listener but does not abort a waterfall that is already running).
  const unload = new AbortController();
  ctx.effect?.(() => () => unload.abort(new Error("@plannotator/dsh was unloaded")));
  if (resolved.planReview) {
    // Prepended: DSH's own Web answerer registers per client stream, and
    // listeners run in registration order.
    ctx.on("user-questions/request", createPlanReviewListener(ctx, resolved, { unloadSignal: unload.signal }), { prepend: true });
  }
  const inboxDeps: DshInboxDeps = { ...deps, unloadSignal: deps.unloadSignal ? AbortSignal.any([unload.signal, deps.unloadSignal]) : unload.signal };
  if (typeof ctx.inject === "function") {
    try {
      // Not awaited: a DSH where a service never comes must still finish loading this plugin.
      ctx.inject(DSH_INBOX_SERVICES, (child) => startInbox(child, inboxDeps, onInbox));
      return Promise.resolve();
    } catch (error) {
      warnOf(ctx)("plannotator: could not wait for DSH's agents and tools (%s); starting the Inbox connection now", error instanceof Error ? error.message : String(error));
    }
  }
  return startInbox(ctx as unknown as DshInboxContext, inboxDeps, onInbox);
}
