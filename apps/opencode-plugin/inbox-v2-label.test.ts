/**
 * Session labels on OpenCode 2 (approval "inbox-session-label"): the session's
 * own title reaches the Inbox on the wake's polls, and a rename reaches it
 * without a lookup. The failures this catches: the default title drawn as if
 * someone chose it; a lookup that fails blanking a known title; a child
 * session's rename landing on its root; a title kept after it was removed.
 *
 * The host is a fake with an event stream; the Inbox is a recorder of polls, so
 * this needs no build. `session.renamed` is the event the V2 schema defines
 * (`SessionEvent.Renamed`, `{ sessionID, title }`); `session.updated` is the
 * older one (`{ sessionID, info }`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeSessionLabel, registerInboxOpenCode2, type InboxToolDomainLike } from "./inbox";
import { InboxAgentConnection } from "../../packages/shared/inbox/agent-link";
import { INBOX_BRIDGE_POLL_PATH } from "../../packages/shared/inbox/connection";

const roots: string[] = [];
const stops: AbortController[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("openCodeSessionLabel", () => {
  test.each([
    ["New session - 2026-11-01T10:42:07.123Z"],
    ["Child session - 2026-11-01T10:42:07.123Z"],
    [""],
    [undefined],
    [42],
  ])("%p is nothing", (title) => {
    expect(openCodeSessionLabel(title)).toBe("");
  });

  test.each([["Fix login redirect"], ["New session - planning"], ["New session"], ["冲突筛查圆桌 · kelu"]])("%p is a real title", (title) => {
    expect(openCodeSessionLabel(title)).toBe(title);
  });
});

function eventStream() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  return {
    emit(event: unknown) {
      queue.push(event);
      wake?.();
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
      })();
    },
  };
}

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Two wakes' worth of world: a recorded Inbox, and a fake host whose answers the test changes. */
async function world(options: { events?: boolean; title?: string; failing?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-oc2-label-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  const labels: unknown[] = [];
  const polls: { session?: unknown; label?: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (new URL(req.url).pathname === INBOX_BRIDGE_POLL_PATH) {
        const body = (await req.json()) as { session?: unknown; label?: unknown };
        polls.push(body);
        labels.push(body.label);
      }
      return Response.json({ commands: [] });
    },
  });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ v: 1, pid: process.pid, port: server.port, token: "t".repeat(40), serverSession: "srv", url: `http://127.0.0.1:${server.port}` }));
  const events = eventStream();
  const host: { title: unknown; gets: number; failing: boolean; held: Promise<void> | null } = { title: options.title, gets: 0, failing: options.failing ?? false, held: null };
  const v2 = {
    location: { directory: root },
    ...(options.events === false ? {} : { event: { subscribe: events.subscribe } }),
    session: {
      get: async () => {
        host.gets += 1;
        const title = host.title;
        await host.held;
        if (host.failing) throw new Error("no answer");
        return { location: { directory: root }, title };
      },
      wait: async () => undefined,
      prompt: async () => undefined,
    },
  };
  const connection = new InboxAgentConnection({ dataDir, host: "opencode", agentName: "OpenCode", tools: [{ name: "send_message", description: "", inputSchema: { type: "object", properties: {} } }] });
  let apply: Parameters<NonNullable<InboxToolDomainLike["transform"]>>[0] | null = null;
  const stop = new AbortController();
  stops.push(stop);
  stop.signal.addEventListener("abort", () => void server.stop(true));
  await registerInboxOpenCode2({ transform: (fn) => void (apply = fn) }, v2 as never, connection, async (sessionID) => ({ root: sessionID }), { signal: stop.signal });
  let tool: { execute: (input: unknown, context: { sessionID: string }) => Promise<unknown> } | null = null;
  apply!({ add: (definition) => (tool = definition as never) });
  // The session is watched from its first tool call, as in a real session.
  const watch = (sessionID: string) => tool!.execute({ action: "nothing" }, { sessionID });
  await watch("ses_root");
  return { labels, polls, events, host, watch };
}

/** A poll of the running wake that carries `label`; the wake long-polls a recorder that answers at once. */
const sees = (labels: unknown[], label: unknown) => until(`a poll with ${JSON.stringify(label)}`, () => labels.at(-1) === label);

describe.skipIf(process.platform === "win32")("the wake's polls", () => {
  test("carry the session's title, asked once, and each rename event replaces it", async () => {
    const { labels, events, host } = await world();
    await sees(labels, "");
    const asked = host.gets;
    events.emit({ type: "session.renamed", data: { sessionID: "ses_root", title: "Fix login redirect" } });
    await sees(labels, "Fix login redirect");
    events.emit({ type: "session.updated", data: { sessionID: "ses_root", info: { title: "Migrate auth tokens" } } });
    await sees(labels, "Migrate auth tokens");
    // The older event carries the whole session: a default title there is no title.
    events.emit({ type: "session.updated", data: { sessionID: "ses_root", info: { title: "New session - 2026-11-01T10:42:07.123Z" } } });
    await sees(labels, "");
    // The events keep it current: no poll asks the host again.
    expect(host.gets).toBe(asked);
  });

  test("a title the session already has shows from the first poll, with no event", async () => {
    const { labels } = await world({ title: "Named before the plugin saw it" });
    await sees(labels, "Named before the plugin saw it");
    expect(labels[0]).toBe("Named before the plugin saw it");
  });

  test("a rename of a session no wake watches is dropped: not its root's, and not its own once it is watched", async () => {
    const { labels, polls, events, host, watch } = await world();
    await sees(labels, "");
    events.emit({ type: "session.renamed", data: { sessionID: "ses_other", title: "A subagent's task" } });
    // Events are read in order, so this one showing means that one was read.
    events.emit({ type: "session.renamed", data: { sessionID: "ses_root", title: "The root" } });
    await sees(labels, "The root");
    expect(labels).not.toContain("A subagent's task");

    host.title = "What the host says now";
    await watch("ses_other");
    await until("a poll of the newly watched session", () => polls.some((poll) => poll.session === "ses_other"));
    expect(polls.filter((poll) => poll.session === "ses_other").every((poll) => poll.label === "What the host says now")).toBe(true);
    expect(labels).not.toContain("A subagent's task");
  });

  test("a rename that lands while the lookup is out wins over the lookup's older answer", async () => {
    // Nothing known yet, so each poll asks; the next lookup then stays out until released.
    const { labels, events, host } = await world({ title: "Named before the rename", failing: true });
    await sees(labels, "");
    let release = () => {};
    host.held = new Promise<void>((resolve) => (release = resolve));
    host.failing = false;
    const asked = host.gets;
    await until("the lookup to go out", () => host.gets > asked);
    events.emit({ type: "session.renamed", data: { sessionID: "ses_root", title: "Renamed while asking" } });
    await Bun.sleep(100);
    release();
    await sees(labels, "Renamed while asking");
    expect(labels).not.toContain("Named before the rename");
  });

  test("with no event stream each poll asks, and a failed lookup keeps the last word", async () => {
    const { labels, host } = await world({ events: false });
    host.title = "First";
    await sees(labels, "First");
    host.title = "Second";
    await sees(labels, "Second");
    host.failing = true;
    const before = labels.length;
    await until("two more polls", () => labels.length >= before + 2);
    expect(labels.at(-1)).toBe("Second");
  });
});
