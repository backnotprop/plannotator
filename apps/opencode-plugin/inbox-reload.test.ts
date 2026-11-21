/**
 * OpenCode 2 and a newer Plannotator (owner approval "reload-hosts"):
 *  - the wake's poll reports what this service loaded and what is on disk
 *    (`plugin: { version, on_disk }`), and a plugin generation folder deleted
 *    under it (the install script clears OpenCode's cache) makes the Inbox say
 *    `opencode2 reload`;
 *  - the plugin's setup returns a cleanup, which OpenCode 2 calls when it
 *    unloads the generation (`opencode2 reload`, a plugin update, an hour
 *    idle): it ends the Inbox wakes, so an unloaded generation stops polling.
 * A real Inbox under a temp data dir; the OpenCode 2 host is a fake that
 * streams events from `event.subscribe` (the real-host proof of the same rows
 * is in the PR's sandbox runs). No real OpenCode, no model.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InboxAgentConnection } from "@plannotator/shared/inbox/agent-link";
import { findInboxConnection, openCodePluginReporter, registerInboxOpenCode2 } from "./inbox";
import serverPlugin from "./server";
import {
  createInboxWorld,
  destroyInboxWorld,
  registry,
  removeStubbedHtml,
  startInbox,
  stubBuiltHtml,
  waitFor,
  type InboxWorld,
} from "../../tests/helpers/inbox-world";

const packageVersion = (await Bun.file(path.join(import.meta.dir, "package.json")).json()).version as string;

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const scratch: string[] = [];
const saved = { ...process.env };
const stops: (() => void)[] = [];

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const w of worlds.splice(0)) await destroyInboxWorld(w);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An OpenCode 2 event stream the test feeds, ending when the subscriber's signal aborts. */
function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let aborted = 0;
  return {
    emit(event: unknown) {
      queue.push(event);
      wake?.();
    },
    get aborted() {
      return aborted;
    },
    subscribe({ signal }: { signal?: AbortSignal } = {}) {
      return (async function* () {
        while (!signal?.aborted) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        aborted++;
      })();
    },
  };
}

function world(name: string): InboxWorld {
  const w = createInboxWorld("plannotator-inbox-oc2-reload-", name, "opencode2");
  worlds.push(w);
  startInbox(w);
  mkdirSync(w.dataDir, { recursive: true });
  writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
  process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
  process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
  return w;
}

type OpenSession = { session: string; plugin: string | null; outdated: { fix: string; reload_command?: string; runtime?: string; fallback_command?: string } | null };

async function openCodeSession(w: InboxWorld, session: string): Promise<OpenSession | null> {
  const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/agents`)).json()) as {
    sessions?: { opencode?: { sessions: OpenSession[] } };
  };
  return model.sessions?.opencode?.sessions.find((s) => s.session === session) ?? null;
}

describe("openCodePluginReporter", () => {
  test("the loaded version, and the version on disk now; null once the generation folder is deleted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plannotator-oc2-gen-"));
    scratch.push(dir);
    const file = path.join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "@plannotator/opencode", version: "0.28.30" }));
    let now = 1_000;
    const report = openCodePluginReporter(file, "0.28.30", () => now);
    expect(report()).toEqual({ version: "0.28.30", on_disk: "0.28.30" });
    rmSync(dir, { recursive: true, force: true });
    // Read at most every 2 s: the cached answer first, then the folder is gone.
    expect(report()).toEqual({ version: "0.28.30", on_disk: "0.28.30" });
    now += 2_000;
    expect(report()).toEqual({ version: "0.28.30", on_disk: null });
    // No loaded version: nothing to report.
    expect(openCodePluginReporter(file, null)()).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("OpenCode 2 reload signals over a real Inbox", () => {
  test("a deleted generation folder under the running service: the Inbox says `opencode2 reload`, and the sidebar counts it", async () => {
    const w = world("01-opencode2-generation-deleted");
    const connection = await findInboxConnection();
    expect(connection).not.toBeNull();
    const generation = path.join(w.root, "generation");
    mkdirSync(generation, { recursive: true });
    const pkg = path.join(generation, "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "@plannotator/opencode", version: "0.28.30" }));
    const events = eventStream();
    const v2 = {
      location: { directory: w.project },
      event: { subscribe: events.subscribe },
      session: { get: async () => ({ location: { directory: w.project } }), wait: async () => undefined, prompt: async () => undefined },
    };
    const stop = new AbortController();
    stops.push(() => stop.abort());
    let clock = Date.now();
    await registerInboxOpenCode2({ transform: () => {} }, v2 as never, connection!, async (sessionID) => ({ root: sessionID }), {
      signal: stop.signal,
      plugin: openCodePluginReporter(pkg, "0.28.30", () => clock),
    });
    events.emit({ type: "session.execution.started", data: { sessionID: "ses_gen" } });
    const upToDate = await waitFor("the session listed with its plugin", async () => {
      const entry = await openCodeSession(w, "ses_gen");
      return entry?.plugin ? entry : null;
    });
    expect(upToDate).toMatchObject({ plugin: "0.28.30", outdated: null });
    w.proof("listed: plugin 0.28.30, up to date");

    // The install script clears OpenCode's cache: the folder the service loaded is gone.
    rmSync(generation, { recursive: true, force: true });
    clock += 2_000;
    const stale = await waitFor(
      "the session to need a reload",
      async () => {
        const entry = await openCodeSession(w, "ses_gen");
        return entry?.outdated ? entry : null;
      },
      30_000,
    );
    expect(stale.outdated).toMatchObject({ fix: "reload", runtime: "opencode", reload_command: "opencode2 reload", fallback_command: "opencode2 service restart" });
    const list = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads?archived=exclude`)).json()) as {
      restart_agents?: { total: number; runtimes: Record<string, number> };
      restart_claude_code?: number;
    };
    expect(list.restart_agents).toEqual({ total: 1, runtimes: { opencode: 1 } });
    // An older window reads Claude Code's count only: unchanged.
    expect(list.restart_claude_code).toBe(0);
    w.proof("generation deleted: opencode2 reload; restart_agents counts it");
  }, 60_000);

  test("setup returns a cleanup: unloading the generation ends its Inbox wake (no more polls)", async () => {
    const w = world("02-opencode2-cleanup");
    const events = eventStream();
    let pending: ((draft: { add?: (tool: Record<string, unknown>) => void }) => void) | null = null;
    const ctx = {
      options: { workflow: "manual" },
      location: { directory: w.project },
      agent: { list: async () => ({ data: [] }), transform: async () => ({ dispose: async () => {} }) },
      event: { subscribe: events.subscribe },
      session: {
        get: async () => ({ location: { directory: w.project } }),
        wait: async () => undefined,
        prompt: async () => undefined,
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: {
        transform: async (apply: (draft: { add?: (tool: Record<string, unknown>) => void }) => void) => {
          pending = apply;
          return { dispose: async () => {} };
        },
      },
    };
    // Count the wake's bridge polls, before and after the cleanup.
    const original = InboxAgentConnection.prototype.bridge;
    let polls = 0;
    InboxAgentConnection.prototype.bridge = function (this: InboxAgentConnection, ...args: Parameters<typeof original>) {
      if (String(args[0]).endsWith("/poll")) polls++;
      return original.apply(this, args);
    } as typeof original;
    stops.push(() => {
      InboxAgentConnection.prototype.bridge = original;
    });

    const cleanup = await serverPlugin.setup(ctx as never);
    expect(typeof cleanup).toBe("function");
    expect(pending).not.toBeNull();
    events.emit({ type: "session.execution.started", data: { sessionID: "ses_cleanup" } });
    const listed = await waitFor("the session to poll", async () => {
      const entry = await openCodeSession(w, "ses_cleanup");
      return entry ? entry : null;
    });
    // This checkout's own package.json, read from beside the source: what the service loaded.
    expect(listed.plugin).toBe(packageVersion);
    expect(polls).toBeGreaterThan(0);

    (cleanup as () => void)();
    await waitFor("the event subscription to end", () => (events.aborted === 1 ? true : undefined), 5_000);
    const after = polls;
    await Bun.sleep(3_000);
    expect(polls).toBe(after);
    w.proof(`cleanup ended the wake: ${after} polls before, none after 3 s`);
  }, 60_000);
});
