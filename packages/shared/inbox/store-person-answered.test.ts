import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const WAITING = [
  { step: "Fix the batch cursor", status: "done" },
  { step: "Approve the backfill plan", status: "waiting" },
];

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-answered-"));
  roots.push(dir);
  let now = Date.parse("2026-11-07T12:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "The backfill plan is ready.", subject: "Backfill" }).message.id;
  const setList = () => store.setThreadSteps({ thread_id: thread, agent: AGENT, steps: WAITING }).record!.updated_at;
  return { store, project, thread, setList, advance: (ms: number) => (now += ms) };
}

describe("the person answered since a checklist", () => {
  test("nothing from the person since the list: not answered", () => {
    const w = world();
    w.advance(60_000);
    const since = w.setList();
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(false);
  });

  test("a typed reply after the list: answered; the agent rewriting its list after it: waits again", () => {
    const w = world();
    w.advance(60_000);
    const since = w.setList();
    w.advance(60_000);
    w.store.sendMessage({ project_id: w.project.id, author: { kind: "person" }, body: "Go ahead.", reply_to: w.thread });
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(true);
    w.advance(60_000);
    const later = w.store.setThreadSteps({ thread_id: w.thread, agent: AGENT, steps: [...WAITING, { step: "Pick the window", status: "todo" }] }).record!.updated_at;
    expect(w.store.personAnsweredSince(w.thread, later)).toBe(false);
  });

  test("a reply at the same moment as the list counts (never left amber on a tie)", () => {
    const w = world();
    w.advance(60_000);
    const since = w.setList();
    w.store.sendMessage({ project_id: w.project.id, author: { kind: "person" }, body: "Go ahead.", reply_to: w.thread });
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(true);
  });

  test("👍 Looks good on the agent's message after the list: answered, though its note is never listed; taken back: not", () => {
    const w = world();
    w.advance(60_000);
    const since = w.setList();
    w.advance(60_000);
    w.store.ackMessage(w.thread, true);
    expect(w.store.thread(w.thread)!.messages.some((m) => m.author.kind === "person")).toBe(false);
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(true);
    w.advance(1_000);
    w.store.ackMessage(w.thread, false);
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(false);
  });

  test("a 👍 from before the list does not count", () => {
    const w = world();
    w.advance(60_000);
    w.store.ackMessage(w.thread, true);
    w.advance(60_000);
    const since = w.setList();
    expect(w.store.personAnsweredSince(w.thread, since)).toBe(false);
  });
});
