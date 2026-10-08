/**
 * Plannotator Snapshots for OpenCode 2: the native `/plannotator-snapshot`
 * command and each session's link to the Snapshots hub. The logic shared with
 * the Pi extension is `packages/shared/snapshots/agent-link.ts`; this file is
 * the OpenCode side of it.
 *
 * Decided once at plugin setup: only where the Snapshots switch is on
 * (`PLANNOTATOR_SNAPSHOTS` / `{ "snapshots": false }`, on by default for every
 * agent). Off, nothing is added and no hub is contacted.
 *
 * Costs nothing while unused. On macOS a 5 s check looks for a RUNNING hub
 * (a registry file read, then a loopback health call); only while one is up
 * does the plugin subscribe to OpenCode's events to learn which sessions run
 * here and which one the person typed into last, and each linked session's
 * "Ask this session" bridge (which watches the session) exists only while
 * its link is connected. The hub going away ends the subscription and the
 * bridges; a deleted session ends its link; the plugin's cleanup ends all of
 * it. Elsewhere (capture is macOS only) nothing runs until the person runs
 * `/plannotator-snapshot`, which explains and links that session on demand
 * (`plannotator snapshot add` / `open` still send from there).
 *
 * Non-blocking, like the other native commands: `/plannotator-snapshot` runs
 * `plannotator snapshot --session opencode:<root session> [--app]` (starts the
 * hub and the app, latches the session, opens the capture overlay) and
 * returns. The person's Send arrives later with `session.prompt({ delivery:
 * "queue" })`, the text the hub composed, as a turn of its own once the
 * session is idle. A successful command posts NO transcript notice (the
 * capture overlay is the answer): a notice is a pending steer row, and a
 * queued Send would wake the session with that row promoted ALONE as its own
 * model step (#1515). A command that fails does post one (the person must see
 * why), and a Send that arrives while that row is still pending goes in as a
 * steer, so the two are promoted together (`createNoticePendingTracker`).
 *
 * Links are per ROOT session (a subagent's command links the session the
 * person works in). OpenCode 1 keeps the markdown command stub, which runs
 * the blocking `plannotator snapshot --wait`.
 */

import { randomBytes } from "node:crypto";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import { loadConfig, resolveSnapshotsEnabled } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { isSnapshotsHubRunning, SnapshotsAgentLink, summonSnapshots } from "@plannotator/shared/snapshots/agent-link";
import { createOpenCodeMessageId, createOpenCodeSessionBridge, type OpenCodeSessionBridge } from "./opencode-session-bridge";
import {
  createCommandFailureNotifier,
  createNoticePendingTracker,
  type NoticePendingTracker,
  type V2CommandDefinition,
  type V2ContextLike,
} from "./v2-client";

export const SNAPSHOTS_COMMAND = "plannotator-snapshot";
/**
 * Distinct from the markdown stub's description on purpose: the native
 * commands' reclaim reads it back to tell our definition from the stub.
 */
export const SNAPSHOTS_COMMAND_DESCRIPTION =
  "Capture your screen with Plannotator Snapshots, mark it up, and send it to this session as one message (--app: App Capture)";
/** Marks the Send's prompt in the session. */
const SNAPSHOTS_PROMPT_SOURCE = "plannotator-snapshots";
/** How often macOS looks for a running hub. */
const HUB_WATCH_MS = 5_000;

export interface OpenCodeSnapshotsOptions {
  resolveRoot: (sessionID: string) => Promise<{ root: string }>;
  /** Test seams. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  retryMs?: number;
  hubWatchMs?: number;
}

export interface OpenCodeSnapshots {
  command: V2CommandDefinition;
  /** Link a root session (idempotent). */
  watch(rootSessionID: string): SnapshotsAgentLink<OpenCodeSessionBridge> | null;
  /** Whether the event subscription runs (a hub is up). */
  readonly subscribed: boolean;
  /** Bridges currently alive (one per connected link). */
  readonly liveBridges: number;
  dispose(): void;
}

/** Null when Snapshots is switched off. */
export function createOpenCodeSnapshots(v2: V2ContextLike, options: OpenCodeSnapshotsOptions): OpenCodeSnapshots | null {
  const env = options.env ?? process.env;
  if (!resolveSnapshotsEnabled(loadConfig(), env)) return null;
  const platform = options.platform ?? process.platform;
  const dataDir = getPlannotatorDataDir();
  const processId = randomBytes(6).toString("hex");
  const links = new Map<string, SnapshotsAgentLink<OpenCodeSessionBridge>>();
  /** A failed command's notice, per root session, while it may still be an un-promoted row. */
  const notices = new Map<string, NoticePendingTracker>();
  /** Session ids already looked up (root or child), so each is resolved once per subscription. */
  const seen = new Set<string>();
  let liveBridges = 0;
  let disposed = false;
  let events: AbortController | null = null;
  let hubTimer: ReturnType<typeof setInterval> | null = null;

  const directoryOf = async (sessionID: string): Promise<string> => {
    try {
      const directory = (await v2.session?.get?.({ sessionID }))?.location?.directory;
      if (typeof directory === "string" && directory) return directory;
    } catch {
      // Fall through to the plugin's folder.
    }
    return v2.location?.directory || process.cwd();
  };

  const deliver = async (root: string, text: string) => {
    const prompt = v2.session?.prompt;
    if (typeof prompt !== "function") throw new Error("this OpenCode cannot receive a prompt from a plugin");
    // Our failed command's notice still pending: steer, so both are promoted
    // together and the notice never runs a model step alone. Otherwise
    // "queue": a turn of its own once the session is idle.
    const notice = notices.get(root);
    const coPromote = notice?.pending() === true;
    if (notice) {
      notice.dispose();
      notices.delete(root);
    }
    await prompt({
      sessionID: root,
      id: createOpenCodeMessageId(),
      text,
      delivery: coPromote ? "steer" : "queue",
      metadata: { source: SNAPSHOTS_PROMPT_SOURCE },
    });
  };

  const watch = (root: string): SnapshotsAgentLink<OpenCodeSessionBridge> | null => {
    seen.add(root);
    if (disposed || platform === "win32" || typeof v2.session?.prompt !== "function") return null;
    const known = links.get(root);
    if (known) return known;
    let bridge: OpenCodeSessionBridge | null = null;
    const link = new SnapshotsAgentLink<OpenCodeSessionBridge>({
      dataDir,
      host: "opencode",
      sessionId: root,
      processId,
      cwd: v2.location?.directory || process.cwd(),
      // Made only while connected to a hub: the bridge watches the session.
      createBridge: () => {
        liveBridges += 1;
        bridge = createOpenCodeSessionBridge({ ctx: v2, sessionID: root, modes: { turn: true, transient: false } });
        return bridge;
      },
      releaseBridge: (released) => {
        liveBridges -= 1;
        released.dispose();
        if (bridge === released) bridge = null;
      },
      ask: { turn: true, transient: false },
      runClient: runPullSessionBridgeClient,
      ...(options.retryMs ? { retryMs: options.retryMs } : {}),
      target: {
        isBusy: () => bridge?.status() === "busy",
        deliver: (text) => deliver(root, text),
      },
      log: (line) => {
        if (env.PLANNOTATOR_DEBUG) console.error(line);
      },
    });
    links.set(root, link);
    link.start();
    return link;
  };

  const unlink = (sessionID: string) => {
    links.get(sessionID)?.dispose();
    links.delete(sessionID);
    notices.get(sessionID)?.dispose();
    notices.delete(sessionID);
  };

  // Which sessions run here and which one the person typed into last; only
  // while a hub is up. Best effort (#44788): without events the command alone links.
  const startEvents = () => {
    const subscribe = v2.event?.subscribe;
    if (events || disposed || typeof subscribe !== "function") return;
    const controller = new AbortController();
    events = controller;
    seen.clear();
    void (async () => {
      try {
        for await (const event of subscribe({ signal: controller.signal })) {
          if (!event || typeof event !== "object") continue;
          const { type, data } = event as { type?: unknown; data?: Record<string, unknown> };
          const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;
          if (!sessionID) continue;
          if (type === "session.execution.started" && !seen.has(sessionID)) {
            seen.add(sessionID);
            void options.resolveRoot(sessionID).then(({ root }) => watch(root), () => undefined);
          } else if (type === "session.inbox.enqueued" && (data?.item as { type?: unknown } | undefined)?.type === "user") {
            links.get(sessionID)?.noteHumanInput();
          } else if (type === "session.deleted") {
            unlink(sessionID);
          }
        }
      } catch {
        // Best effort.
      } finally {
        if (events === controller) events = null;
      }
    })();
  };

  const stopEvents = () => {
    events?.abort();
    events = null;
  };

  /** The hub went away: no subscription, and every link's bridge ends with its connection. */
  const hubDown = () => {
    stopEvents();
    for (const link of links.values()) link.dropConnection();
  };

  if (platform === "darwin") {
    let checking = false;
    hubTimer = setInterval(() => {
      if (checking || disposed) return;
      checking = true;
      void isSnapshotsHubRunning(dataDir)
        .then((running) => (running ? startEvents() : hubDown()))
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, options.hubWatchMs ?? HUB_WATCH_MS);
    (hubTimer as { unref?: () => void }).unref?.();
  }

  const command: V2CommandDefinition = {
    name: SNAPSHOTS_COMMAND,
    description: SNAPSHOTS_COMMAND_DESCRIPTION,
    execute: async (invocation) => {
      const sessionID = invocation.sessionID;
      const { root } = await options.resolveRoot(sessionID).catch(() => ({ root: sessionID }));
      const link = watch(root);
      link?.noteHumanInput();
      const answer = await summonSnapshots({
        dataDir,
        host: "opencode",
        sessionId: root,
        args: typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "",
        cwd: await directoryOf(sessionID),
        platform,
        env,
      });
      // The hub may have just started: connect now rather than at the next registry check.
      link?.kick();
      if (answer.ok) return;
      // The person must see why; a Send that follows while this row is pending co-promotes with it.
      const notify = createCommandFailureNotifier(v2, root);
      if (!notify) {
        console.error(`[Plannotator] /${SNAPSHOTS_COMMAND} failed: ${answer.text}`);
        return;
      }
      notices.get(root)?.dispose();
      const tracker = createNoticePendingTracker(v2, root);
      notices.set(root, tracker);
      tracker.posting();
      try {
        const admitted = (await notify({ command: SNAPSHOTS_COMMAND, message: answer.text })) as { id?: unknown } | undefined;
        tracker.admitted(typeof admitted?.id === "string" && admitted.id ? admitted.id : undefined);
      } catch (error) {
        tracker.rejected();
        console.error(`[Plannotator] /${SNAPSHOTS_COMMAND} failed: ${answer.text} (${error instanceof Error ? error.message : String(error)})`);
      }
    },
  };

  return {
    command,
    watch,
    get subscribed() {
      return events !== null;
    },
    get liveBridges() {
      return liveBridges;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (hubTimer) clearInterval(hubTimer);
      hubTimer = null;
      stopEvents();
      for (const root of [...links.keys()]) unlink(root);
      for (const tracker of notices.values()) tracker.dispose();
      notices.clear();
    },
  };
}
