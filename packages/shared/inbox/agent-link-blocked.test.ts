/**
 * "Stuck on a prompt in its terminal" through the link Pi, Oh My Pi and OpenCode 2 share (agent-link.ts `InboxWake`,
 * its target's `blocked`; each host's own word on its prompts is tested beside it: apps/pi-extension/inbox-blocked.test.ts,
 * apps/opencode-plugin/inbox-blocked.test.ts). The failures these guard:
 *  - a prompt coming up or going not told to the Inbox at once (a `state` event), or not repeated on each poll;
 *  - a `state` event or poll that still says blocked after the prompt is over (the field must be absent then);
 *  - anything but the kind sent (a title, a command);
 *  - a word without `blocked_at`, or one not later than the word before it (the Inbox orders by it);
 *  - the silent link rule broken: a request while no Inbox has run (no registry), prompt or not.
 * A stand-in connection records what would go to the Inbox: no Inbox, no server, no agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "./agent-link";
import { INBOX_BLOCKED_AT_FIELD, INBOX_BLOCKED_FIELD, INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, type InboxBlockedKind } from "./connection";

const dirs: string[] = [];
const wakes: InboxWake[] = [];
afterEach(() => {
  for (const wake of wakes.splice(0)) wake.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A wake on a stand-in connection: every bridge body by path. */
function wakeOf(blocked: () => InboxBlockedKind | null) {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-link-blocked-"));
  dirs.push(dataDir);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const connection = {
    dataDir,
    host: "pi",
    options: { env: {} },
    bridge: async (path: string, _session: string, body: Record<string, unknown>) => {
      sent.push({ path, body });
      return { status: 200, text: JSON.stringify({ commands: [] }) };
    },
  } as unknown as InboxAgentConnection;
  const target: InboxWakeTarget = { isBusy: () => true, deliver: async () => {}, notify: () => {}, blocked };
  const wake = new InboxWake(connection, "ses-1", target, 5);
  wakes.push(wake);
  wake.start();
  const states = () => sent.filter((entry) => entry.path === INBOX_BRIDGE_EVENT_PATH && entry.body.type === "state").map((entry) => entry.body);
  const polls = () => sent.filter((entry) => entry.path === INBOX_BRIDGE_POLL_PATH).map((entry) => entry.body);
  return { states, polls };
}

const until = async (what: () => boolean) => {
  for (let i = 0; i < 400 && !what(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(what()).toBe(true);
};

describe("the shared link tells the Inbox what waits in the terminal", () => {
  test("up: a state event with the kind alone, and every later poll repeats it; gone: a state event without the field", async () => {
    let now: InboxBlockedKind | null = null;
    const { states, polls } = wakeOf(() => now);
    await until(() => polls().length > 0);
    now = "permission";
    await until(() => states().some((body) => body[INBOX_BLOCKED_FIELD] !== undefined));
    expect(states().at(-1)![INBOX_BLOCKED_FIELD]).toEqual({ kind: "permission" });
    // Polls from now on repeat it.
    const upAt = polls().length;
    await until(() => polls().length > upAt + 1);
    expect(polls().at(-1)![INBOX_BLOCKED_FIELD]).toEqual({ kind: "permission" });
    now = null;
    await until(() => INBOX_BLOCKED_FIELD in states().at(-1)! === false);
    // And stop once it went: the latest word stands.
    const goneAt = polls().length;
    await until(() => polls().length > goneAt + 1);
    expect(INBOX_BLOCKED_FIELD in polls().at(-1)!).toBe(false);
    // Each word says when it changed, the clearing one later than the one it clears.
    const up = states().find((body) => body[INBOX_BLOCKED_FIELD] !== undefined)!;
    const gone = states().at(-1)!;
    expect(gone[INBOX_BLOCKED_AT_FIELD] as number).toBeGreaterThan(up[INBOX_BLOCKED_AT_FIELD] as number);
    expect(typeof polls().at(-1)![INBOX_BLOCKED_AT_FIELD]).toBe("number");
  });

  test("no Inbox has run (no registry): a prompt up sends nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-link-silent-"));
    dirs.push(dataDir);
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    try {
      let read = 0;
      const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [], env: {} });
      const target: InboxWakeTarget = { isBusy: () => true, deliver: async () => {}, notify: () => {}, blocked: () => (read++, "permission") };
      const wake = new InboxWake(connection, "ses-1", target, 5);
      wakes.push(wake);
      wake.start();
      await until(() => read > 3);
      expect(requests).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
