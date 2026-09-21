/**
 * Native slash commands for OpenCode 2.
 *
 * OpenCode's V2 plugin API gained command EXECUTION in anomalyco/opencode
 * PR #44765 (issue #2185): the command draft grew an `add({ name, description,
 * execute })` method whose callback fully owns the invocation, so nothing
 * reaches the model unless it says so. That shape currently ships only on the
 * `beta` and `dev` dist-tags of `@opencode-ai/plugin`; `next` and `latest`
 * still carry a draft of `{ list, get, update, remove }` with no `add`.
 *
 * `ctx.command.transform` therefore proves NOTHING: it exists on both. The only
 * honest probe is the draft handed to the callback, which is what this module
 * checks. On an older host it adds nothing and the markdown command stubs stay
 * the (model-mediated) fallback.
 *
 * Execution reuses the exact V1 machinery, `handleCliCommand`, over a
 * translation client, so the two hosts cannot drift.
 */

import { handleCliCommand, type OpenCodeBridgeAgent, type OpenCodeBridgeContext } from "./cli-bridge";
import {
  createV2BridgeClient,
  readListPayload,
  type V2CommandDraft,
  type V2CommandInvocation,
  type V2ContextLike,
} from "./v2-client";

/**
 * Descriptions are deliberately NOT copies of the markdown stubs' frontmatter.
 * They are the provenance signal the reclaim below reads back out of
 * `ctx.command.list()` to tell our definition from the config-loaded stub, and
 * `native-commands.test.ts` pins that they stay distinct.
 */
export const NATIVE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: "plannotator-review",
    description:
      "Open the Plannotator code review UI for current changes or a PR URL; pass --git or --gitbutler to force that provider",
  },
  {
    name: "plannotator-annotate",
    description: "Open the Plannotator annotation UI for a file, folder, or URL",
  },
  {
    name: "plannotator-last",
    description: "Annotate the last assistant message in Plannotator",
  },
];

/**
 * Delay BEFORE each ownership re-check, in milliseconds. The loop awaits these
 * one after another, so the ticks land at roughly 0.3s, 1.5s, 5.5s and 15.5s
 * after setup.
 *
 * Four bounded ticks, then it stops for good. Plugin activation and the config
 * command scan both finish well inside that window; a host slower than that
 * keeps the fallback, which still works.
 */
const RECLAIM_SCHEDULE_MS = [300, 1_200, 4_000, 10_000] as const;

export interface CliCommandRequest {
  command: string;
  client: unknown;
  sessionId?: string;
  rawArgs: string;
  cwd?: string;
  bridge?: OpenCodeBridgeContext;
}

export interface NativeCommandDeps {
  ctx: V2ContextLike;
  getAgents: () => Promise<OpenCodeBridgeAgent[]>;
  getBridgeContext: () => Promise<OpenCodeBridgeContext>;
  /**
   * Injection seam for tests only; production always uses `handleCliCommand`.
   * Bun's `mock.module` is process-global and cannot be unset, so a module mock
   * of `cli-bridge` here would leak into every other suite.
   */
  runCommand?: (request: CliCommandRequest) => Promise<void>;
  /** Test seam for the reclaim schedule; production uses real timers. */
  wait?: (ms: number) => Promise<void>;
}

/** Resolve the invocation's working directory, session location first. */
async function resolveDirectory(ctx: V2ContextLike, sessionID: string): Promise<string> {
  try {
    const session = await ctx.session?.get?.({ sessionID });
    const directory = session?.location?.directory;
    if (typeof directory === "string" && directory) return directory;
  } catch {
    // Fall through to the plugin location, then the process cwd.
  }
  return ctx.location?.directory || process.cwd();
}

export async function runNativeCommand(
  command: string,
  invocation: V2CommandInvocation,
  deps: NativeCommandDeps,
): Promise<void> {
  const sessionID = invocation.sessionID;
  // The raw argument tail, exactly as OpenCode 1 forwards it. The CLI's own
  // tolerant argument resolution takes it from here: nothing is parsed or
  // rewritten on the way through.
  const rawArgs = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "";
  // `sessionID` is what lets the bridge put the session URL where the user can
  // actually see it. Without it (and on a host with no `session.synthetic`) a
  // remote review would only print its URL into a stream OpenCode discards.
  const client = createV2BridgeClient({ ctx: deps.ctx, getAgents: deps.getAgents, sessionID });

  const run = deps.runCommand ?? ((request: CliCommandRequest) => handleCliCommand(request as never));
  try {
    await run({
      command,
      client,
      sessionId: sessionID,
      rawArgs,
      cwd: await resolveDirectory(deps.ctx, sessionID),
      bridge: await deps.getBridgeContext(),
    });
  } finally {
    // The client may be watching the host's event stream for its session-URL
    // notice. A review that ends without sending feedback never settles that
    // watch on its own, so the invocation closes it. Disposing twice is a no-op.
    client.dispose();
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the host process open for a background reconciliation.
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Do our definitions currently own all three names?
 *
 * `ctx.command.list()` returns the MATERIALIZED command map, so a description
 * that is not ours means another transform (in practice OpenCode's own
 * ConfigCommandPlugin, replaying the installed markdown stubs) added the name
 * after us and won.
 */
async function ownsNativeCommands(ctx: V2ContextLike): Promise<boolean> {
  const list = await ctx.command?.list?.();
  const commands = readListPayload(list);
  return NATIVE_COMMANDS.every((command) => commands.some((entry) =>
    entry.name === command.name && entry.description === command.description));
}

/**
 * Take the three names back from the config-loaded markdown stubs.
 *
 * Mechanism, verified against anomalyco/opencode `origin/v2`:
 *  - Command definitions live in a name-keyed Map and `draft.add` is a
 *    `Map.set` (`packages/core/src/command.ts`), so the LAST transform to add a
 *    name wins.
 *  - Transforms replay in registration order: `transforms = [...transforms,
 *    transform]`, and `materialize` walks that array
 *    (`packages/core/src/state.ts`).
 *  - Activation order is `pre` -> packages -> `post`, and OpenCode's own
 *    ConfigCommandPlugin, which scans `~/.config/opencode/{command,commands}/
 *    **\/*.md`, sits in `post` (`packages/core/src/plugin/internal.ts:265-269`,
 *    `packages/core/src/plugin/supervisor.ts`).
 * So a setup-time transform ALWAYS replays before config's, and the stubs the
 * installer writes shadow the native definitions on every normal install. The
 * fix is to register the same transform once more after activation settles, so
 * ours is last in the replay order; from then on it stays last, because config
 * only ever calls `reload()` and never re-registers.
 *
 * The explicit `reload()` is belt and braces, not a requirement: each plugin's
 * effect runs inside `State.batch` (`packages/core/src/plugin.ts`), but the
 * batch clears its active flag before flushing, so a registration arriving
 * after that takes the direct path and materializes on its own. Calling
 * `reload()` anyway costs one recompute and removes any dependence on that
 * ordering detail holding in a future OpenCode.
 *
 * Deliberately not driven by `ctx.event.subscribe()`: upstream #44788 reports
 * that stream as unreliable on some V2 nightlies, and `command.list()` is a
 * direct read of committed state with no bus involved.
 *
 * Failure mode: if this never gets to run, or the host has no `list`/`reload`,
 * or a future OpenCode reorders activation, the markdown stubs keep winning and
 * the three commands still work through their model-mediated fallback bodies.
 * Degraded, never broken.
 */
export async function reclaimNativeCommands(input: {
  ctx: V2ContextLike;
  apply: () => Promise<void>;
  isSupported: () => boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const wait = input.wait ?? defaultWait;
  const list = input.ctx.command?.list;
  const reload = input.ctx.command?.reload;
  if (typeof list !== "function" || typeof reload !== "function") return;

  let reclaimed = false;
  for (const delay of RECLAIM_SCHEDULE_MS) {
    await wait(delay);
    // The draft probe only runs when the transform REPLAYS, which under boot
    // batching is at the flush after every plugin has loaded. Plannotator loads
    // before the post-group config plugins, so an early tick can legitimately
    // see this false: skip the tick, never end the loop, or the reclaim would
    // be inert in exactly the shape production has.
    if (!input.isSupported()) continue;

    let owned: boolean;
    try {
      owned = await ownsNativeCommands(input.ctx);
    } catch {
      return;
    }
    // Owning the names on an early tick can simply mean config has not loaded
    // yet, so ownership alone is not an exit condition: only ownership that
    // outlives a reclaim is.
    if (owned) {
      if (reclaimed) return;
      continue;
    }

    try {
      await input.apply();
      await reload();
      reclaimed = true;
    } catch {
      return;
    }
  }
}

/**
 * Register the three Plannotator commands when the host's draft supports it.
 *
 * Returns whether the draft accepted them. Note the callback may not have run
 * by the time `transform` resolves: during boot the host coalesces transforms
 * into one batched reload, so the honest answer arrives a tick later. The
 * reclaim loop re-reads the same flag rather than trusting this snapshot.
 */
export async function registerNativeCommands(deps: NativeCommandDeps): Promise<boolean> {
  const transform = deps.ctx.command?.transform;
  if (typeof transform !== "function") return false;

  let supported = false;
  const apply = async () => {
    await transform((draft: V2CommandDraft) => {
      // The ONLY honest capability probe: `transform` exists on hosts whose
      // draft is `{ list, get, update, remove }`, where `add` is undefined and
      // calling it would throw inside the batched reload flush, aborting it
      // before commit and taking every command registration down with it.
      if (typeof draft?.add !== "function") return;
      supported = true;
      for (const command of NATIVE_COMMANDS) {
        draft.add({
          name: command.name,
          description: command.description,
          execute: async (invocation) => {
            try {
              await runNativeCommand(command.name, invocation, deps);
            } catch (error) {
              // handleCliCommand already logs and swallows everything except a
              // prompt-delivery failure. Report that one and stop: rethrowing
              // would surface an OpenCode command execution error for feedback
              // the reviewer has already given.
              console.error(
                `[Plannotator] /${command.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          },
        });
      }
    });
  };

  await apply();

  void reclaimNativeCommands({
    ctx: deps.ctx,
    apply,
    isSupported: () => supported,
    wait: deps.wait,
  });

  return supported;
}
