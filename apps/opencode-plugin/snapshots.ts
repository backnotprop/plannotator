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
 * Non-blocking, like the other native commands: `/plannotator-snapshot` runs
 * `plannotator snapshot --session opencode:<root session> [--app]` (starts the
 * hub and the app, latches the session, opens the capture overlay), shows its
 * line as a transcript notice that starts no turn, and returns. The person's
 * Send arrives later with `session.prompt({ delivery: "queue" })`, the text
 * the hub composed, as a turn of its own once the session is idle (never
 * "steer": it would join a run that started the same instant). "Ask this
 * session" from the HUD is a real turn through the same session bridge the
 * reviews use (`opencode-session-bridge.ts`).
 *
 * Links are per ROOT session (a subagent's command links the session the
 * person works in), made by the command or the first run this process sees
 * in a session, so a hotkey-started collection can go to the session the
 * person typed into last (`session.inbox.enqueued` user rows). OpenCode 1
 * keeps the markdown command stub, which runs the blocking
 * `plannotator snapshot --wait`.
 */

import { randomBytes } from "node:crypto";
import { runPullSessionBridgeClient } from "@plannotator/ai/session-bridge-pull-client";
import { loadConfig, resolveSnapshotsEnabled } from "@plannotator/shared/config";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { SnapshotsAgentLink, summonSnapshots } from "@plannotator/shared/snapshots/agent-link";
import { createOpenCodeMessageId, createOpenCodeSessionBridge, type OpenCodeSessionBridge } from "./opencode-session-bridge";
import { createCommandFailureNotifier, createCommandNoticeNotifier, type V2CommandDefinition, type V2ContextLike } from "./v2-client";

export const SNAPSHOTS_COMMAND = "plannotator-snapshot";
/**
 * Distinct from the markdown stub's description on purpose: the native
 * commands' reclaim reads it back to tell our definition from the stub.
 */
export const SNAPSHOTS_COMMAND_DESCRIPTION =
  "Capture your screen with Plannotator Snapshots, mark it up, and send it to this session as one message (--app: App Capture)";
/** Marks the Send's prompt in the session. */
const SNAPSHOTS_PROMPT_SOURCE = "plannotator-snapshots";

export interface OpenCodeSnapshotsOptions {
  resolveRoot: (sessionID: string) => Promise<{ root: string }>;
  /** Test seams. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  retryMs?: number;
}

export interface OpenCodeSnapshots {
  command: V2CommandDefinition;
  /** Link a root session (idempotent); a later call says the session is in use here. */
  watch(rootSessionID: string): SnapshotsAgentLink<OpenCodeSessionBridge> | null;
  dispose(): void;
}

/** Null when Snapshots is switched off. */
export function createOpenCodeSnapshots(v2: V2ContextLike, options: OpenCodeSnapshotsOptions): OpenCodeSnapshots | null {
  const env = options.env ?? process.env;
  if (!resolveSnapshotsEnabled(loadConfig(), env)) return null;
  const platform = options.platform ?? process.platform;
  const dataDir = getPlannotatorDataDir();
  const processId = randomBytes(6).toString("hex");
  const links = new Map<string, { link: SnapshotsAgentLink<OpenCodeSessionBridge>; bridge: OpenCodeSessionBridge }>();
  /** Session ids already looked up (root or child), so each is resolved once. */
  const seen = new Set<string>();
  const controller = new AbortController();

  const directoryOf = async (sessionID: string): Promise<string> => {
    try {
      const directory = (await v2.session?.get?.({ sessionID }))?.location?.directory;
      if (typeof directory === "string" && directory) return directory;
    } catch {
      // Fall through to the plugin's folder.
    }
    return v2.location?.directory || process.cwd();
  };

  const watch = (root: string): SnapshotsAgentLink<OpenCodeSessionBridge> | null => {
    seen.add(root);
    if (platform === "win32" || typeof v2.session?.prompt !== "function") return null;
    const known = links.get(root);
    if (known) return known.link;
    const bridge = createOpenCodeSessionBridge({ ctx: v2, sessionID: root, modes: { turn: true, transient: false } });
    const link = new SnapshotsAgentLink<OpenCodeSessionBridge>({
      dataDir,
      host: "opencode",
      sessionId: root,
      processId,
      cwd: v2.location?.directory || process.cwd(),
      bridge,
      ask: { turn: true, transient: false },
      runClient: runPullSessionBridgeClient,
      ...(options.retryMs ? { retryMs: options.retryMs } : {}),
      target: {
        isBusy: () => bridge.status() === "busy",
        deliver: async (text) => {
          const prompt = v2.session?.prompt;
          if (typeof prompt !== "function") throw new Error("this OpenCode cannot receive a prompt from a plugin");
          // "queue": the send runs as a turn of its own once the session is idle.
          await prompt({ sessionID: root, id: createOpenCodeMessageId(), text, delivery: "queue", metadata: { source: SNAPSHOTS_PROMPT_SOURCE } });
        },
      },
      log: (line) => {
        if (env.PLANNOTATOR_DEBUG) console.error(line);
      },
    });
    links.set(root, { link, bridge });
    link.start();
    return link;
  };

  // Which sessions run here and which one the person typed into last. Best
  // effort (#44788): without events the command alone links a session.
  const subscribe = v2.event?.subscribe;
  if (typeof subscribe === "function") {
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
            links.get(sessionID)?.link.noteHumanInput();
          } else if (type === "session.deleted") {
            const entry = links.get(sessionID);
            entry?.link.dispose();
            entry?.bridge.dispose();
            links.delete(sessionID);
          }
        }
      } catch {
        // Best effort.
      }
    })();
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
      // A transcript row for the person that starts no model turn.
      try {
        if (answer.ok) await createCommandNoticeNotifier(v2, sessionID)?.(answer.text);
        else await createCommandFailureNotifier(v2, sessionID)?.({ command: SNAPSHOTS_COMMAND, message: answer.text });
      } catch (error) {
        console.error(`[Plannotator] /${SNAPSHOTS_COMMAND}: ${answer.text} (${error instanceof Error ? error.message : String(error)})`);
      }
    },
  };

  return {
    command,
    watch,
    dispose() {
      controller.abort();
      for (const { link, bridge } of links.values()) {
        link.dispose();
        bridge.dispose();
      }
      links.clear();
    },
  };
}
