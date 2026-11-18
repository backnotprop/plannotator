/**
 * What an agent's Rex pane says, folded into what the Inbox says of it (inbox-rex-status.ts). The failures these
 * guard: Rex overriding what the Inbox knows of its own threads (a question waiting on the person shown as working);
 * an ended session brought back by a stale record; a pane blocked on a terminal prompt shown as idle; a pane at rest
 * hiding a turn the Inbox knows runs.
 */
import { describe, expect, test } from "bun:test";
import type { InboxAgent } from "@plannotator/core/inbox-types";
import { withRexStatus } from "./inbox-rex-status";

const agent = (state: InboxAgent["state"], waiting = 0): InboxAgent => ({ id: "ses_a", session: "ses_a", host: "claude-code", project: null, state, waiting, live: state !== "ended", started_at: null, last_seen_at: null });

describe("an agent's state with its Rex pane's word", () => {
  test("the Inbox's own word comes first: a thread waiting on the person, or an ended session, stays as it is", () => {
    expect(withRexStatus(agent("waiting", 1), { state: "working" })).toEqual(agent("waiting", 1));
    expect(withRexStatus(agent("ended"), { state: "blocked", kind: "question" })).toEqual(agent("ended"));
  });

  test("blocked in the pane: waiting on you, with the kind (a prompt the Inbox cannot see)", () => {
    expect(withRexStatus(agent("working"), { state: "blocked", kind: "permission" })).toMatchObject({ state: "waiting", waiting: 0, rex_status: { state: "blocked", kind: "permission" } });
    expect(withRexStatus(agent("idle"), { state: "blocked" })).toMatchObject({ state: "waiting", rex_status: { state: "blocked" } });
  });

  test("working in the pane: working; at rest in the pane never hides a turn the Inbox knows runs", () => {
    expect(withRexStatus(agent("idle"), { state: "working" })).toMatchObject({ state: "working" });
    expect(withRexStatus(agent("working"), { state: "idle" })).toEqual(agent("working"));
    expect(withRexStatus(agent("working"), { state: "done" })).toEqual(agent("working"));
  });

  test("done or failed in the pane: still idle, and the card says which", () => {
    expect(withRexStatus(agent("idle"), { state: "done" })).toMatchObject({ state: "idle", rex_status: { state: "done" } });
    expect(withRexStatus(agent("idle"), { state: "error" })).toMatchObject({ state: "idle", rex_status: { state: "error" } });
    expect(withRexStatus(agent("idle"), null)).toEqual(agent("idle"));
  });
});
