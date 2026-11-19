/**
 * The live sessions keep what each session's connection said it waits on in its terminal (INBOX_BLOCKED_FIELD), and
 * the rule that keeps it honest: the latest poll or `state` event stands (one without it clears it), and a word not
 * said again within INBOX_BLOCKED_STALE_MS is dropped. The failures these guard: a prompt shown after its connection
 * stopped saying it (a lost end, a hung plugin), after a poll or event without it, or for a session that is no longer
 * live; a field this Inbox does not know shown at all; an older connection (no field) ever reading as blocked; the
 * Agents signature not moving when it changes, expiry included (the windows would not read the list again); a poll
 * built before the event that cleared it, arriving after, setting it again (`blocked_at` orders them). A real store in a temp
 * folder: no server.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BLOCKED_AT_FIELD, INBOX_BLOCKED_FIELD, INBOX_BLOCKED_STALE_MS, INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-blocked-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  let now = 1_000_000;
  const live = createInboxLiveSessions({ store, serverSession: "s", resolveRoot: async (path) => path, now: () => now });
  const poll = async (body: Record<string, unknown>) => (await live.pollStarted("ses-1", "claude-code", { busy: true, ...body }))();
  const state = (body: Record<string, unknown>) => live.stateChanged("ses-1", "claude-code", { type: "state", busy: true, ...body });
  const blocked = () => live.agentSessions(0).find((entry) => entry.session === "ses-1")?.blocked ?? null;
  return { live, poll, state, blocked, pass: (ms: number) => void (now += ms) };
}

test("a poll's or state event's word stands until the next says otherwise; one without it clears it", async () => {
  const { poll, state, blocked } = world();
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "permission", command: "rm -rf /" } });
  expect(blocked()).toBe("permission");
  state({ [INBOX_BLOCKED_FIELD]: { kind: "question" } });
  expect(blocked()).toBe("question");
  state({});
  expect(blocked()).toBeNull();
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "question" } });
  await poll({});
  expect(blocked()).toBeNull();
  // A kind this Inbox does not know (a newer connection's): none.
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "auth" } });
  expect(blocked()).toBeNull();
});

test("not said again within the stale time: dropped though the session is live; said again: kept; not live: none", async () => {
  const { live, poll, blocked, pass } = world();
  // A poll held open keeps the session live however long it waits (a hung plugin that says nothing more).
  const release = await live.pollStarted("ses-1", "claude-code", { busy: true, [INBOX_BLOCKED_FIELD]: { kind: "permission" } });
  pass(INBOX_BLOCKED_STALE_MS - 1_000);
  expect(blocked()).toBe("permission");
  pass(2_000);
  expect(live.agentSessions(0).find((entry) => entry.session === "ses-1")?.live).toBe(true);
  expect(blocked()).toBeNull();
  release();
  // Each poll says it again (polls come at most 25 s apart): kept.
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "question" } });
  pass(20_000);
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "question" } });
  pass(20_000);
  expect(blocked()).toBe("question");
  // Gone (no poll for longer than a live session's window): nothing.
  pass(INBOX_SESSION_LIVE_MS * 3);
  expect(blocked()).toBeNull();
});

test("an older connection never sends the field: never blocked", async () => {
  const { poll, state, blocked } = world();
  await poll({});
  state({ busy: false });
  expect(blocked()).toBeNull();
});

test("a change moves the Agents signature (the windows read the list again)", async () => {
  const { live, poll, pass } = world();
  await poll({});
  const before = live.agentsSignature(0);
  await poll({ [INBOX_BLOCKED_FIELD]: { kind: "permission" } });
  const up = live.agentsSignature(0);
  expect(up).not.toBe(before);
  // Gone stale on its own: the signature moves back with no poll.
  pass(INBOX_BLOCKED_STALE_MS + 1_000);
  expect(live.agentsSignature(0)).not.toBe(up);
});

test("a prompt set and answered between two looks still moves the signature (a window that read it in between reads again)", async () => {
  const { live, poll, state } = world();
  await poll({});
  const before = live.agentsSignature(0);
  state({ [INBOX_BLOCKED_FIELD]: { kind: "permission" } });
  state({});
  const after = live.agentsSignature(0);
  expect(after).not.toBe(before);
  // The timer keeps no sample while no window listens: any number of changes since its last one still differ.
  state({ [INBOX_BLOCKED_FIELD]: { kind: "permission" } });
  state({});
  expect(live.agentsSignature(0)).not.toBe(before);
  expect(live.agentsSignature(0)).not.toBe(after);
  // A turn that ends and starts again between two looks: moved too. Nothing changed: not moved.
  const turned = live.agentsSignature(0);
  state({ busy: false });
  state({ busy: true });
  expect(live.agentsSignature(0)).not.toBe(turned);
  const still = live.agentsSignature(0);
  await poll({});
  state({});
  expect(live.agentsSignature(0)).toBe(still);
});

test("a body whose word is older than the one held changes nothing; one without blocked_at (an older connection) stands", async () => {
  const { live, poll, state, blocked } = world();
  await poll({});
  // The prompt comes up (word at 100), and is answered (word at 200)...
  state({ [INBOX_BLOCKED_FIELD]: { kind: "permission" }, [INBOX_BLOCKED_AT_FIELD]: 100 });
  state({ [INBOX_BLOCKED_AT_FIELD]: 200 });
  expect(blocked()).toBeNull();
  // ...then a poll built while it was up arrives: it is older, so it stays answered.
  const release = await live.pollStarted("ses-1", "claude-code", { busy: true, [INBOX_BLOCKED_FIELD]: { kind: "permission" }, [INBOX_BLOCKED_AT_FIELD]: 100 });
  expect(blocked()).toBeNull();
  release();
  state({ [INBOX_BLOCKED_FIELD]: { kind: "question" }, [INBOX_BLOCKED_AT_FIELD]: 300 });
  expect(blocked()).toBe("question");
  // A body with no blocked_at (an older connection's) is the latest, as before.
  state({});
  expect(blocked()).toBeNull();
});

test("gone stale while the session stays live: the signature moves (the windows drop the mark)", async () => {
  const { live, pass } = world();
  const release = await live.pollStarted("ses-1", "claude-code", { busy: true, [INBOX_BLOCKED_FIELD]: { kind: "permission" } });
  const up = live.agentsSignature(0);
  pass(INBOX_BLOCKED_STALE_MS + 1_000);
  expect(live.agentSessions(0).find((entry) => entry.session === "ses-1")?.live).toBe(true);
  expect(live.agentsSignature(0)).not.toBe(up);
  release();
});
