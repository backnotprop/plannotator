/**
 * The live sessions keep where each session said it lives (INBOX_PLACE_POLL_FIELD), as its latest poll said it. The
 * failures these guard: a place kept after a poll stopped saying it (the session left Rex, or an older connection);
 * a name or any other field from the poll kept with it; a session that is gone still placed. A real store in a temp
 * folder: no server, no Rex.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PLACE_POLL_FIELD, INBOX_SESSION_LIVE_MS } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxLiveSessions } from "./inbox-sessions";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "session:01a1eb88-f030-7da4-aa20-0dc3df15fce2";
const BLOCK = "block:01a1eb88-f030-7eb1-9448-bf75ec96f726";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-place-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  let now = 1_000_000;
  const live = createInboxLiveSessions({ store, serverSession: "s", resolveRoot: async (path) => path, now: () => now });
  const poll = async (session: string, body: Record<string, unknown>) => (await live.pollStarted(session, "claude-code", body))();
  return { live, poll, pass: (ms: number) => void (now += ms) };
}

test("a poll's place is kept as the two ids only, and the latest poll stands", async () => {
  const { live, poll } = world();
  await poll("ses-1", { [INBOX_PLACE_POLL_FIELD]: { kind: "rex", session: SESSION, block: BLOCK, label: "my session", tab: "agent" } });
  expect(live.placeOf("ses-1")).toEqual({ kind: "rex", session: SESSION, block: BLOCK });
  // A poll without it (an older connection, or the session no longer in Rex): none.
  await poll("ses-1", {});
  expect(live.placeOf("ses-1")).toBeNull();
  // A newer connection's kind this Inbox does not know: none, and the poll still works.
  await poll("ses-1", { [INBOX_PLACE_POLL_FIELD]: { kind: "elsewhere", id: 1 } });
  expect(live.placeOf("ses-1")).toBeNull();
});

test("a session that is no longer live has no place; one never seen has none", async () => {
  const { live, poll, pass } = world();
  await poll("ses-1", { [INBOX_PLACE_POLL_FIELD]: { kind: "rex", session: SESSION, block: BLOCK } });
  expect(live.placeOf("ses-1")).not.toBeNull();
  pass(INBOX_SESSION_LIVE_MS * 10);
  expect(live.placeOf("ses-1")).toBeNull();
  expect(live.placeOf("ses-unknown")).toBeNull();
});
