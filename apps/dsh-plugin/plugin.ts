/**
 * The plugin's body, behind `index.ts`'s `apply` (which takes no test hooks):
 * plan review at once, and the Inbox connection once DSH's `agents` and
 * `tools` services are active.
 */

import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { resolvePlannotatorBinary } from "./cli";
import { setupDshInbox, type DshInbox, type DshInboxContext, type DshInboxDeps } from "./inbox";
import { createPlanReviewListener, resolveConfig, type DshContext, type ResolvedConfig } from "./plan-review";
import { createDshNative, type DshNative, type DshNativeDeps } from "./tool";

/** The services the Inbox connection and the `plannotator` tool need active before they start (Cordis `inject`). */
export const DSH_INBOX_SERVICES = ["agents", "tools"];

/** The services the `/plannotator-*` commands need. */
export const DSH_COMMAND_SERVICES = ["agents", "commands"];

/** The plugin's test hooks: the Inbox's, and the tool's and commands' (`native`). */
export interface DshPluginDeps extends DshInboxDeps {
  native?: Omit<DshNativeDeps, "env">;
}

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
  deps: DshPluginDeps = {},
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
  const { native: nativeDeps, ...rest } = deps;
  const native = startNative(ctx as unknown as DshInboxContext, resolved, rest, nativeDeps);
  const inboxDeps: DshInboxDeps = { ...rest, unloadSignal: rest.unloadSignal ? AbortSignal.any([unload.signal, rest.unloadSignal]) : unload.signal };
  const root = ctx as unknown as DshInboxContext;
  if (native) {
    if (!injectOrNow(ctx, DSH_COMMAND_SERVICES, (child) => native.registerCommands(child))) native.registerCommands(root);
  }
  // Not awaited: a DSH where a service never comes must still finish loading this plugin.
  const injected = injectOrNow(ctx, DSH_INBOX_SERVICES, (child) => {
    native?.registerTool(child);
    return startInbox(child, inboxDeps, onInbox);
  });
  if (injected) return Promise.resolve();
  native?.registerTool(root);
  return startInbox(root, inboxDeps, onInbox);
}

/** Run `callback` in a Cordis `inject(deps)` child; false when the context has no `inject` or it threw (the caller runs it now). */
function injectOrNow(ctx: DshContext & Partial<Pick<DshInboxContext, "inject">>, services: string[], callback: (child: DshInboxContext) => unknown): boolean {
  if (typeof ctx.inject !== "function") return false;
  try {
    ctx.inject(services, callback);
    return true;
  } catch (error) {
    warnOf(ctx)("plannotator: could not wait for DSH's %s (%s); starting now", services.join(" and "), error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * The `plannotator` tool and the `/plannotator-*` commands (tool.ts), stopped
 * when the plugin unloads (an open review's child is stopped, its draft kept).
 * Null in a profile that takes no turns of ours, or when it cannot start.
 */
function startNative(ctx: DshInboxContext, resolved: ResolvedConfig, deps: DshInboxDeps, nativeDeps: DshPluginDeps["native"]): DshNative | null {
  try {
    const native = createDshNative(
      ctx,
      { resolveBinary: () => resolvePlannotatorBinary({ configured: resolved.binary }), dataDir: deps.dataDir ?? getPlannotatorDataDir() },
      { ...(deps.env && { env: deps.env }), ...nativeDeps },
    );
    if (native) ctx.effect?.(() => () => native.dispose());
    return native;
  } catch (error) {
    warnOf(ctx as unknown as DshContext)("plannotator: the plannotator tool and commands did not start (%s)", error instanceof Error ? error.message : String(error));
    return null;
  }
}
