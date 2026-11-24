/**
 * Swarm threads on disk (swarms.ts) and the New message that starts one (store.startPersonThread with tags). What can
 * regress: a second line from one agent kept beside its first instead of replacing it, an agent's line stored with
 * control characters or many lines, a turn-off that makes a record for a thread that never was a swarm, the record
 * lost on a restart, a newer Plannotator's file overwritten, the file world-readable, and a swarm's other agents not
 * handed the first message (one thread, every agent in it, each with its own delivery).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SWARM_DOING_MAX } from "@plannotator/core/inbox-swarm";
import { InboxError } from "./schema";
import { InboxStore } from "./store";
import { INBOX_SWARMS_FILE, InboxSwarms } from "./swarms";

const T = "msg_01M4H6G73M9H3Z32T859E72DPY";
const dir = () => mkdtempSync(join(tmpdir(), "plannotator-inbox-swarms-"));

describe("InboxSwarms", () => {
  test("on, a line per agent (a new line replaces its last), and all of it back after a restart", () => {
    const d = dir();
    const swarms = new InboxSwarms(d, () => new Date("2026-11-24T14:00:00.000Z"));
    expect(swarms.get(T)).toBeNull();
    expect(swarms.setOn(T, true)?.on).toBe(true);
    swarms.say(T, "ses_a", "Rewriting the rounding");
    swarms.say(T, "ses_b", "Finding the short refunds");
    swarms.say(T, "ses_a", "Adding tests for the rounding");
    const again = new InboxSwarms(d);
    expect(again.get(T)?.on).toBe(true);
    expect(again.get(T)?.doing.map((x) => [x.session, x.text])).toEqual([
      ["ses_b", "Finding the short refunds"],
      ["ses_a", "Adding tests for the rounding"],
    ]);
    expect(statSync(join(d, INBOX_SWARMS_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a line is one line, cut to its length; nothing to say is refused", () => {
    const swarms = new InboxSwarms(dir());
    const said = swarms.say(T, "ses_a", `first\nsecond\u0007 ${"x".repeat(400)}`);
    const text = said.doing[0]!.text;
    expect(text.startsWith("first second")).toBe(true);
    expect(text.includes("\n")).toBe(false);
    expect(text.length).toBeLessThanOrEqual(INBOX_SWARM_DOING_MAX);
    expect(() => swarms.say(T, "ses_a", "  \n ")).toThrow(InboxError);
    expect(() => swarms.say(T, "", "Rewriting")).toThrow(InboxError);
  });

  test("off on a thread that never was a swarm writes nothing; off then on keeps the lines", () => {
    const d = dir();
    const swarms = new InboxSwarms(d);
    expect(swarms.setOn(T, false)).toBeNull();
    expect(() => readFileSync(join(d, INBOX_SWARMS_FILE))).toThrow();
    swarms.setOn(T, true);
    swarms.say(T, "ses_a", "Rewriting the rounding");
    expect(swarms.setOn(T, false)?.on).toBe(false);
    expect(swarms.setOn(T, true)?.doing).toHaveLength(1);
  });

  test("a newer Plannotator's file is read as none and never overwritten", () => {
    const d = dir();
    writeFileSync(join(d, INBOX_SWARMS_FILE), JSON.stringify({ v: 2, swarms: [{ thread_id: T, on: true }] }));
    const swarms = new InboxSwarms(d);
    expect(swarms.get(T)).toBeNull();
    expect(() => swarms.setOn(T, true)).toThrow(InboxError);
    expect(JSON.parse(readFileSync(join(d, INBOX_SWARMS_FILE), "utf8")).v).toBe(2);
  });
});

describe("a New message to several agents", () => {
  const open = () => {
    const store = InboxStore.open(dir(), { now: () => new Date("2026-11-24T14:00:00.000Z") });
    const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
    return { store, project };
  };
  const tags = [
    { host: "codex", session: "ses_b", wakes: true },
    { host: "pi", session: "ses_c", wakes: true },
  ];

  test("one thread: every agent is in it and each is handed the first message", () => {
    const { store, project } = open();
    const { message } = store.startPersonThread({ project_id: project.id, body: "Fix the rounding.", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "k1", tags, swarm: true });
    expect(message.swarm).toBe(true);
    expect(store.participantsOf([message]).map((p) => p.session)).toEqual(["ses_a", "ses_b", "ses_c"]);
    for (const session of ["ses_a", "ses_b", "ses_c"]) expect(store.pendingReplies(session).map((m) => m.id)).toEqual([message.id]);
    // One agent's delivery settles it for that agent only.
    store.recordDelivery(store.deliveryIdOf(message, "ses_b"), { host: "codex", session: "ses_b" });
    expect(store.pendingReplies("ses_b")).toEqual([]);
    expect(store.pendingReplies("ses_c").map((m) => m.id)).toEqual([message.id]);
  });

  test("the addressee is never also a tag, and a lone pick is no swarm", () => {
    const { store, project } = open();
    const { message } = store.startPersonThread({ project_id: project.id, body: "Fix it.", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "k2", tags: [{ host: "claude-code", session: "ses_a", wakes: true }], swarm: true });
    expect(message.tags).toBeUndefined();
    expect(message.swarm).toBeUndefined();
  });
});
