import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_THREAD_PULLS_MAX, parseInboxThreadPullRefs, type InboxAuthor, type InboxThreadPullActor, type InboxThreadPullRef } from "@plannotator/core/inbox-types";
import { InboxError, PULLS_FILE, SEQ_FLOOR_FILE } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const BY_AGENT: InboxThreadPullActor = { kind: "agent", session: "ses_a", host: "claude-code", name: "Claude Code" };
const PERSON: InboxThreadPullActor = { kind: "person" };

function refs(...values: string[]): InboxThreadPullRef[] {
  const parsed = parseInboxThreadPullRefs(values, "add");
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.refs;
}

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-thread-pulls-"));
  roots.push(dir);
  let now = Date.parse("2026-11-08T10:00:00.000Z");
  const open = () => InboxStore.open(dir, { now: () => new Date(now) });
  const store = open();
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Opened the retry PR.", subject: "Invoice retries" }).message.id;
  return { dir, store, project, thread, open, advance: (ms: number) => (now += ms), iso: () => new Date(now).toISOString() };
}

function lines(dir: string, project: { key: string }) {
  return readFileSync(join(dir, "inbox", "projects", project.key, PULLS_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function refusal(run: () => unknown): InboxError {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a thread's PRs", () => {
  test("each add and remove is one line on the store's seq; a PR already there or not there writes nothing", () => {
    const { store, thread, dir, project } = world();
    const first = store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1", "o/r#2"), by: BY_AGENT });
    expect(first.added.map((p) => p.pull)).toEqual(["github.com/o/r#1", "github.com/o/r#2"]);
    const again = store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1"), remove: refs("o/r#9"), by: BY_AGENT });
    expect(again.added).toEqual([]);
    expect(again.already.map((p) => p.pull)).toEqual(["github.com/o/r#1"]);
    expect(again.missing.map((r) => r.key)).toEqual(["github.com/o/r#9"]);
    store.changeThreadPulls({ thread_id: thread, remove: refs("o/r#1"), by: PERSON });
    const written = lines(dir, project);
    expect(written.map((l) => [l.kind, l.record.pull, l.record.removed_by?.kind ?? null])).toEqual([
      ["thread_pull", "github.com/o/r#1", null],
      ["thread_pull", "github.com/o/r#2", null],
      ["thread_pull", "github.com/o/r#1", "person"],
    ]);
    expect(new Set(written.map((l) => l.seq)).size).toBe(3);
    expect(store.threadPulls(thread).map((p) => p.pull)).toEqual(["github.com/o/r#2"]);
  });

  test("PRs added in one call keep the order they were named in", () => {
    const { store, thread } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#30", "o/r#4", "o/a#9"), by: BY_AGENT });
    expect(store.threadPulls(thread).map((p) => p.pull)).toEqual(["github.com/o/r#30", "github.com/o/r#4", "github.com/o/a#9"]);
  });

  test("a message id finds its thread, and an id that is no message is thread_not_found", () => {
    const { store, thread, project } = world();
    const reply = store.sendMessage({ project_id: project.id, author: AGENT, body: "And the follow-up.", reply_to: thread }).message.id;
    store.changeThreadPulls({ thread_id: reply, add: refs("o/r#1"), by: BY_AGENT });
    expect(store.threadPulls(thread)).toHaveLength(1);
    expect(refusal(() => store.changeThreadPulls({ thread_id: "msg_nope", add: refs("o/r#1"), by: BY_AGENT })).code).toBe("thread_not_found");
  });

  test(`at most ${INBOX_THREAD_PULLS_MAX} live PRs: past it nothing is written, removed ones do not count`, () => {
    const { store, thread } = world();
    const many = Array.from({ length: INBOX_THREAD_PULLS_MAX }, (_, i) => `o/r#${i + 1}`);
    store.changeThreadPulls({ thread_id: thread, add: refs(...many), by: BY_AGENT });
    const before = store.threadPullEvents(thread).length;
    const error = refusal(() => store.changeThreadPulls({ thread_id: thread, add: refs("o/r#100", "o/r#101"), by: BY_AGENT }));
    expect(error.code).toBe("validation_error");
    expect(error.message).toContain("at most 20");
    expect(store.threadPullEvents(thread).length).toBe(before);
    const swap = store.changeThreadPulls({ thread_id: thread, add: refs("o/r#100"), remove: refs("o/r#1"), by: PERSON });
    expect(swap.added).toHaveLength(1);
    expect(store.threadPulls(thread)).toHaveLength(INBOX_THREAD_PULLS_MAX);
  });

  test("the person removes a PR, the agent adds it back: the log keeps both, and the record says who added it now", () => {
    const { store, thread, advance, iso } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1"), by: BY_AGENT });
    store.setThreadPullState(thread, "github.com/o/r#1", { state: "open", title: "Retries", base: "main", head: "retries" });
    advance(60_000);
    store.changeThreadPulls({ thread_id: thread, remove: refs("o/r#1"), by: PERSON });
    const removedAt = iso();
    expect(store.threadPullsRemoved(thread, "2026-11-01T00:00:00.000Z").map((p) => p.removed_by)).toEqual([PERSON]);
    advance(60_000);
    store.changeThreadPulls({ thread_id: thread, add: refs("https://github.com/o/r/pull/1"), by: BY_AGENT });
    const [back] = store.threadPulls(thread);
    expect(back!.added_by).toEqual(BY_AGENT);
    expect(back!.removed_at).toBeUndefined();
    expect(back!.state).toBe("open");
    expect(store.threadPullsRemoved(thread, "2026-11-01T00:00:00.000Z")).toEqual([]);
    expect(store.threadPullEvents(thread).map((e) => [e.op, e.by.kind])).toEqual([
      ["add", "agent"],
      ["remove", "person"],
      ["add", "agent"],
    ]);
    expect(removedAt < back!.added_at).toBe(true);
  });

  test("the person's changes since a moment are net: added then removed again says nothing; an agent's changes never count", () => {
    const { store, thread, advance, iso } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1", "o/r#2"), by: BY_AGENT });
    advance(1000);
    const since = iso();
    advance(1000);
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#3"), remove: refs("o/r#1"), by: PERSON });
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#4"), by: PERSON });
    store.changeThreadPulls({ thread_id: thread, remove: refs("o/r#4"), by: PERSON });
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#5"), by: BY_AGENT });
    const changes = store.personPullChangesSince(thread, since);
    expect(changes.added.map((p) => p.pull)).toEqual(["github.com/o/r#3"]);
    expect(changes.removed.map((p) => p.pull)).toEqual(["github.com/o/r#1"]);
  });

  test("a state the reader saw is a line, but not an add or remove, and it never writes when nothing changed", () => {
    const { store, thread, dir, project } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1"), by: BY_AGENT });
    const read = { state: "merged" as const, title: "Retries", base: "main", head: "retries" };
    expect(store.setThreadPullState(thread, "github.com/o/r#1", read)?.state).toBe("merged");
    expect(store.setThreadPullState(thread, "github.com/o/r#1", read)).toBeNull();
    expect(lines(dir, project)).toHaveLength(2);
    expect(store.threadPullEvents(thread)).toHaveLength(1);
  });

  test("remove all takes off what was there; the PRs read back after a restart; the seq floor rises", () => {
    const { store, thread, dir, open } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1", "acme/platform/api!61"), by: BY_AGENT });
    const again = open();
    expect(again.threadPulls(thread).map((p) => p.pull)).toEqual(["github.com/o/r#1", "gitlab.com/acme/platform/api#61:pull"]);
    expect(JSON.parse(readFileSync(join(dir, "inbox", SEQ_FLOOR_FILE), "utf8"))).toEqual({ seq: again.cursor() });
    const cleared = again.changeThreadPulls({ thread_id: thread, remove: "all", by: PERSON });
    expect(cleared.removed).toHaveLength(2);
    expect(open().threadPulls(thread)).toEqual([]);
  });

  test("who is in the thread: an agent that wrote there; not another session", () => {
    const { store, thread } = world();
    expect(store.isThreadMember(thread, "ses_a")).toBe(true);
    expect(store.isThreadMember(thread, "ses_stranger")).toBe(false);
    expect(store.isThreadMember(thread, null)).toBe(false);
  });

  test("a deleted thread's PRs go with it", () => {
    const { store, thread, open } = world();
    store.changeThreadPulls({ thread_id: thread, add: refs("o/r#1"), by: BY_AGENT });
    store.deleteThread(thread);
    expect(store.threadPulls(thread)).toEqual([]);
    expect(open().allThreadPulls()).toEqual([]);
  });
});
