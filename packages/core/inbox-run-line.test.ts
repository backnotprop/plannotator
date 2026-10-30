import { describe, expect, test } from "bun:test";
import { INBOX_RUN_START_GRACE_MS, inboxRunOf, type InboxRunEvidence } from "./inbox-run-line";

const T0 = Date.parse("2026-10-30T16:51:00.000Z");

const evidence = (over: Partial<InboxRunEvidence> = {}): InboxRunEvidence => ({
  launch: { id: "lch_01JZ0000000000000000000000", agent: "claude-code", session_ref: "4f1c9a2e", folder: "/work/app", scratch: false, started_at: new Date(T0).toISOString() },
  project: "app",
  now: T0 + 5_000,
  startedAt: T0,
  again: false,
  cliAvailable: true,
  live: null,
  turnWaiting: false,
  seenLive: false,
  host: null,
  waitingSince: null,
  stoppedByPersonAt: null,
  attachCommand: "cd '/work/app' && claude attach 4f1c9a2e",
  ...over,
});

describe("inboxRunOf", () => {
  test("a fresh start that has not connected yet is starting, and a respawn says again", () => {
    expect(inboxRunOf(evidence())?.state).toBe("starting");
    expect(inboxRunOf(evidence({ again: true }))).toMatchObject({ state: "starting", again: true });
  });

  test("live and busy is working since the turn began; live and idle draws no line", () => {
    const busySince = T0 + 30_000;
    expect(inboxRunOf(evidence({ live: { busy: true, busySince }, seenLive: true }))).toMatchObject({ state: "working", since: new Date(busySince).toISOString() });
    expect(inboxRunOf(evidence({ live: { busy: false, busySince: null }, seenLive: true }))).toBeNull();
  });

  test("connected but not yet on its turn stays starting (the line does not blink out), until the grace runs out", () => {
    const idle = { busy: false, busySince: null };
    expect(inboxRunOf(evidence({ live: idle, turnWaiting: true }))?.state).toBe("starting");
    expect(inboxRunOf(evidence({ live: idle, turnWaiting: true, again: true, seenLive: true }))).toMatchObject({ state: "starting", again: true });
    expect(inboxRunOf(evidence({ live: idle, turnWaiting: true, now: T0 + INBOX_RUN_START_GRACE_MS + 1 }))).toBeNull();
  });

  test("a session blocked on a permission prompt is waiting_terminal even while its mod still polls busy", () => {
    const run = inboxRunOf(evidence({ live: { busy: true, busySince: T0 }, seenLive: true, host: { status: "waiting", state: "running", waitingFor: "permission prompt" }, waitingSince: T0 + 60_000 }));
    expect(run).toMatchObject({ state: "waiting_terminal", since: new Date(T0 + 60_000).toISOString() });
  });

  test("past the grace, a session the host lists as stopped or done (or drops) is stopped; Stop names the person", () => {
    const later = T0 + INBOX_RUN_START_GRACE_MS + 1;
    for (const host of [{ status: null, state: "stopped", waitingFor: null }, { status: null, state: "done", waitingFor: null }, "absent" as const]) {
      expect(inboxRunOf(evidence({ now: later, seenLive: true, host }))?.state).toBe("stopped");
    }
    expect(inboxRunOf(evidence({ now: later, seenLive: true, host: "absent", stoppedByPersonAt: later - 10 }))).toMatchObject({ state: "stopped", stopped_by_person: true });
  });

  test("a start that never connected is failed with the plugin hint, while the host still runs it", () => {
    const run = inboxRunOf(evidence({ now: T0 + INBOX_RUN_START_GRACE_MS + 1, host: { status: "idle", state: "running", waitingFor: null } }));
    expect(run?.state).toBe("failed");
    expect(run?.cause).toContain("plugin");
  });

  test("a recorded error decides first: untrusted offers Open in Terminal, missing CLI is missing", () => {
    const at = new Date(T0).toISOString();
    const untrusted = inboxRunOf(evidence({ launch: { ...evidence().launch, session_ref: null, error: { code: "untrusted", text: "/work/app isn't a trusted folder yet.", at } } }));
    expect(untrusted).toMatchObject({ state: "failed", untrusted: true, cause: "/work/app isn't a trusted folder yet." });
    expect(inboxRunOf(evidence({ launch: { ...evidence().launch, error: { code: "missing", text: "gone", at } } }))?.state).toBe("missing");
  });

  test("the CLI gone from PATH while the session is not live is missing", () => {
    expect(inboxRunOf(evidence({ cliAvailable: false }))?.state).toBe("missing");
  });
});
