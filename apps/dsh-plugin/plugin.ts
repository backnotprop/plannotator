import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { resolvePlannotatorBinary } from "./cli";
import { setupDshInbox, type DshInbox, type DshInboxContext, type DshInboxDeps } from "./inbox";
import { createPlanReviewListener, resolveConfig, type DshContext, type ResolvedConfig } from "./plan-review";
import { createDshNative, type DshNative, type DshNativeDeps } from "./tool";

export const DSH_INBOX_SERVICES = ["agents", "tools"];

export const DSH_COMMAND_SERVICES = ["agents", "commands"];

export interface DshPluginDeps extends DshInboxDeps {
  native?: Omit<DshNativeDeps, "env">;
}

function warnOf(ctx: DshContext) {
  return (format: string, ...args: unknown[]) => {
    try {
      ctx.logger?.warn?.(format, ...args);
    } catch {
    }
  };
}

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

export function applyPlannotator(
  ctx: DshContext & Partial<Pick<DshInboxContext, "inject">>,
  config?: unknown,
  deps: DshPluginDeps = {},
  onInbox?: (inbox: DshInbox | null) => void,
): Promise<void> {
  const resolved = resolveConfig(config);
  const unload = new AbortController();
  ctx.effect?.(() => () => unload.abort(new Error("@plannotator/dsh was unloaded")));
  if (resolved.planReview) {
    ctx.on("user-questions/request", createPlanReviewListener(ctx, resolved, { unloadSignal: unload.signal }), { prepend: true });
  }
  const { native: nativeDeps, ...rest } = deps;
  const native = startNative(ctx as unknown as DshInboxContext, resolved, rest, nativeDeps);
  const inboxDeps: DshInboxDeps = { ...rest, unloadSignal: rest.unloadSignal ? AbortSignal.any([unload.signal, rest.unloadSignal]) : unload.signal };
  const root = ctx as unknown as DshInboxContext;
  if (native) {
    if (!injectOrNow(ctx, DSH_COMMAND_SERVICES, (child) => native.registerCommands(child))) native.registerCommands(root);
  }
  const injected = injectOrNow(ctx, DSH_INBOX_SERVICES, (child) => {
    native?.registerTool(child);
    return startInbox(child, inboxDeps, onInbox);
  });
  if (injected) return Promise.resolve();
  native?.registerTool(root);
  return startInbox(root, inboxDeps, onInbox);
}

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
