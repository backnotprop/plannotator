/**
 * Naming a thread the person started (approval "inbox-agent-names-own-thread"):
 * the person may give it a name in compose; otherwise the first reply from the
 * session it is addressed to that carries `thread` names it, once. The name is
 * the thread's chip (`thread_name`), and later sends with that name join it.
 * What can regress: another session renaming it, a second name replacing the
 * first, the person's name being replaced, the subject changing, routing
 * after a replay, an invalid name being stored, a name another open thread
 * has pulling that thread's sends in, and a retry answering differently.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-naming-"));
  roots.push(dir);
  return dir;
}

function world() {
  const dir = scratch();
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const claude = { host: "claude-code", session: "ses_live" };
const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });
const IDEA =
  "I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out.";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("naming a thread the person started", () => {
  test("the addressed session's first reply with `thread` names it, once; the subject stays the short name", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);
    expect(store.canNameThread(root.id, "ses_other")).toBe(false);

    // A reply with no name: still nameable, and the result says so.
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "On it.", reply_to: root.id });
    expect(first.naming).toEqual({ status: "unnamed" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);

    // An invalid name is refused (nothing stored); the thread stays nameable.
    const bad = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "x", reply_to: root.id, thread: "line\nbreak" });
    expect(bad.naming).toMatchObject({ status: "refused", code: "invalid_thread_name" });
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();

    // The first valid name sets the chip and `named_by`; the bold subject is unchanged.
    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Sketch below.", reply_to: root.id, thread: "Kanban board" });
    expect(named.naming).toEqual({ status: "named", name: "Kanban board" });
    const after = store.message(root.id)!;
    expect(after.thread_name).toBe("Kanban board");
    expect(after.subject).toBe("I want to explore what adding a board would look like");
    expect(after.named_by).toMatchObject({ kind: "agent", session: "ses_live", message_id: named.message.id });
    expect(store.listRow(root.id)!.thread_name).toBe("Kanban board");
    expect(store.canNameThread(root.id, "ses_live")).toBe(false);

    // Once: a later name is ignored, and the result no longer mentions naming.
    const again = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "More.", reply_to: root.id, thread: "Something else" });
    expect(again.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name).toBe("Kanban board");
  });

  test("only `thread` names it: a reply's `subject` does not", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, subject: "Board view" });
    expect(reply.naming).toEqual({ status: "unnamed" });
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);
  });

  test("only the addressed session may name it; another session's name is ignored", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const other = store.sendMessage({ project_id: project.id, author: agent("ses_other"), body: "hi", reply_to: root.id, thread: "Hijack" });
    expect(other.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);
  });

  test("once the address moved, the new addressee and the first agent to reply may name it", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    store.readdressMessage(root.id, { host: "pi", session: "ses_pi" });
    expect(store.threadNamers(root.id)).toEqual(["ses_pi"]);
    // The old session replies first (it read the thread): now it may name it too.
    store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "I saw it.", reply_to: root.id });
    expect(store.threadNamers(root.id)).toEqual(["ses_pi", "ses_live"]);
    expect(store.canNameThread(root.id, "ses_third")).toBe(false);
    const named = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_pi", name: null }, body: "ok", reply_to: root.id, thread: "Board" });
    expect(named.naming?.status).toBe("named");
  });

  test("a name the person gave in compose is the chip from the start, and no agent replaces it", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "  Board  " });
    expect(root.thread_name).toBe("Board");
    expect(root.named_by).toMatchObject({ kind: "person" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(false);
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Kanban" });
    expect(reply.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name).toBe("Board");
    // An invalid name refuses the Send, writing nothing; an empty one is no name.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "x", to: claude, idempotency_key: "k2", thread_name: "a‮b" }))).toBe("validation_error");
    expect(store.personThreadByKey("k2")).toBeNull();
    const empty = store.startPersonThread({ project_id: project.id, body: "y", to: claude, idempotency_key: "k3", thread_name: "   " });
    expect(empty.message.thread_name ?? null).toBeNull();
    // A replay with another name is a different Send.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Other" }))).toBe("idempotency_key_reused");
    expect(store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Board" }).replayed).toBe(true);
  });

  test("a name another open thread has is refused: that thread's sends stay where they are", () => {
    const { store, project } = world();
    // Session B already posts to an open thread called "Auth refactor".
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "B's work", thread: "Auth refactor" });
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });

    // The addressed agent names the person's thread "auth  Refactor": refused, the thread stays unnamed and nameable.
    const refused = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "auth  Refactor" });
    expect(refused.naming).toMatchObject({ status: "refused", code: "thread_name_taken" });
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);

    // B's next send still lands in B's own thread.
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "B again", thread: "Auth refactor" }).message.thread_id).toBe(b.message.thread_id);

    // Another name is taken.
    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Kanban board" });
    expect(named.naming).toEqual({ status: "named", name: "Kanban board" });

    // The compose field is refused the same way, writing nothing.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "x", to: claude, idempotency_key: "k2", thread_name: "AUTH REFACTOR" }))).toBe("thread_name_taken");
    expect(store.personThreadByKey("k2")).toBeNull();

    // A resolved thread does not hold its name.
    store.resolveThread(b.message.thread_id, true);
    const { message: later } = store.startPersonThread({ project_id: project.id, body: "y", to: claude, idempotency_key: "k3" });
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: later.id, thread: "Auth refactor" }).naming?.status).toBe("named");
  });

  test("a named thread takes later sends with its name, and a replay routes the same", () => {
    const { dir, store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Board" });
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "joins", thread: "BOARD" }).message.thread_id).toBe(root.id);

    // A name the person typed in compose routes nothing: another session's send with it starts its own thread.
    const { message: named } = store.startPersonThread({ project_id: project.id, body: "another idea", to: claude, idempotency_key: "k2", thread_name: "Relay" });
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_c"), body: "x", thread: "relay" }).message.thread_id).not.toBe(named.id);

    // The store reopened from its files routes the next sends the same.
    const copy = scratch();
    cpSync(dir, copy, { recursive: true });
    const replayed = InboxStore.open(copy);
    expect(replayed.message(root.id)!.thread_name).toBe("Board");
    expect(replayed.canNameThread(root.id, "ses_live")).toBe(false);
    for (const name of ["board", "Relay"]) {
      const probe = { project_id: project.id, author: agent("ses_probe"), body: "probe", thread: name };
      expect(replayed.sendMessage(probe).message.thread_id).toBe(store.sendMessage(probe).message.thread_id);
    }
  });

  test("a retry answers what the first call answered; the same key with another `thread` is refused", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const input = { project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Board", idempotency_key: "r1" };
    const first = store.sendMessage(input);
    const cursor = store.cursor();
    const again = store.sendMessage(input);
    expect(again.replayed).toBe(true);
    expect(again.naming).toEqual(first.naming!);
    expect(again.naming).toEqual({ status: "named", name: "Board" });
    expect(store.cursor()).toBe(cursor);
    expect(code(() => store.sendMessage({ ...input, thread: "Other" }))).toBe("idempotency_key_reused");
    expect(code(() => store.sendMessage({ ...input, thread: undefined }))).toBe("idempotency_key_reused");

    // A refusal replays as the refusal, even once the name is free.
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "B", thread: "Auth" });
    const { message: other } = store.startPersonThread({ project_id: project.id, body: "idea", to: claude, idempotency_key: "k2" });
    const taken = { project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: other.id, thread: "Auth", idempotency_key: "r2" };
    expect(store.sendMessage(taken).naming).toMatchObject({ status: "refused", code: "thread_name_taken" });
    store.resolveThread(b.message.thread_id, true);
    expect(store.sendMessage(taken)).toMatchObject({ replayed: true, naming: { status: "refused", code: "thread_name_taken" } });
    expect(store.message(other.id)!.thread_name ?? null).toBeNull();
  });

  test("agent-started threads are unchanged: a reply's `thread` and `subject` are ignored", () => {
    const { store, project } = world();
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "news", subject: "Relay retries" });
    expect(store.canNameThread(first.message.id, "ses_live")).toBe(false);
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "more", reply_to: first.message.id, thread: "x", subject: "y" });
    expect(reply.naming).toBeUndefined();
    expect(store.message(first.message.id)!).toMatchObject({ subject: "Relay retries", thread_name: null });
  });
});

describe("compose's suggested name (thread_name_auto)", () => {
  test("shown as the chip at once, but the addressed agent's first name replaces it, once; routing follows the new name after a replay", () => {
    const { dir, store, project } = world();
    const { message: root } = store.startPersonThread({
      project_id: project.id,
      body: IDEA,
      to: claude,
      idempotency_key: "k",
      thread_name: "Kanban board",
      thread_name_auto: true,
    });
    expect(root.thread_name).toBe("Kanban board");
    expect(root.named_by).toMatchObject({ kind: "auto" });
    expect(store.listRow(root.id)!.thread_name).toBe("Kanban board");
    // A suggestion is not the person's name: the agent may still name it.
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);

    // The suggestion routes nothing (the reviewer's repro: another session's send with it starts its own thread).
    const elsewhere = store.sendMessage({ project_id: project.id, author: agent("ses_other"), body: "elsewhere", thread: "kanban BOARD" });
    expect(elsewhere.message.thread_id).not.toBe(root.id);
    // That thread now holds the name, so the agent names the person's thread something else.
    store.resolveThread(elsewhere.message.thread_id, true);

    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Sketch.", reply_to: root.id, thread: "Board columns" });
    expect(named.naming).toEqual({ status: "named", name: "Board columns" });
    expect(store.message(root.id)!.thread_name).toBe("Board columns");
    expect(store.message(root.id)!.named_by).toMatchObject({ kind: "agent", session: "ses_live" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(false);

    // The old name no longer reaches the thread; the new one does. A replay of the log agrees.
    for (const s of [store, InboxStore.open(dir)]) {
      const viaOld = s.sendMessage({ project_id: project.id, author: agent("ses_x"), body: `old ${s === store ? 1 : 2}`, thread: "Kanban board" });
      expect(viaOld.message.thread_id).not.toBe(root.id);
      const viaNew = s.sendMessage({ project_id: project.id, author: agent("ses_y"), body: `new ${s === store ? 1 : 2}`, thread: "board columns" });
      expect(viaNew.message.thread_id).toBe(root.id);
    }
  });

  test("an agent may give the suggestion itself as the name", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Kanban board", thread_name_auto: true });
    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Kanban board" });
    expect(named.naming).toEqual({ status: "named", name: "Kanban board" });
    expect(store.message(root.id)!.named_by).toMatchObject({ kind: "agent" });
  });

  test("best effort: a suggestion another open thread has, or that is not a valid name, is dropped without refusing the Send", () => {
    const { store, project } = world();
    store.startPersonThread({ project_id: project.id, body: "first", to: claude, idempotency_key: "k1", thread_name: "Relay budget" });
    const taken = store.startPersonThread({ project_id: project.id, body: "second", to: claude, idempotency_key: "k2", thread_name: "relay BUDGET", thread_name_auto: true });
    expect(taken.message.thread_name ?? null).toBeNull();
    expect(taken.message.named_by).toBeUndefined();
    const invalid = store.startPersonThread({ project_id: project.id, body: "third", to: claude, idempotency_key: "k3", thread_name: "a\u202eb", thread_name_auto: true });
    expect(invalid.message.thread_name ?? null).toBeNull();
    // The same name typed by the person is still refused.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "fourth", to: claude, idempotency_key: "k4", thread_name: "relay BUDGET" }))).toBe("thread_name_taken");
  });

  test("New review's suggestion (thread_name_numbered) is numbered when taken, never dropped; a freed number is reused; a long name is cut to fit", () => {
    const { store, project } = world();
    const send = (key: string, name: string) =>
      store.startPersonThread({ project_id: project.id, body: `review ${key}`, to: claude, idempotency_key: key, thread_name: name, thread_name_auto: true, thread_name_numbered: true }).message;
    const name = "Review web-app: uncommitted on main";
    expect(send("r1", name).thread_name).toBe(name);
    expect(send("r2", name).thread_name).toBe(`${name} (2)`);
    const third = send("r3", "review WEB-APP: uncommitted on main");
    expect(third.thread_name).toBe(`review WEB-APP: uncommitted on main (3)`);
    expect(third.named_by).toMatchObject({ kind: "auto" });
    // An archived (resolved) thread frees its number.
    store.resolveThread(third.id, true);
    expect(send("r4", name).thread_name).toBe(`${name} (3)`);
    // At the 120-character limit the base is cut so the number still fits.
    const long = `Review #869: ${"x".repeat(107)}`;
    expect([...long].length).toBe(120);
    expect(send("l1", long).thread_name).toBe(long);
    const numbered = send("l2", long).thread_name!;
    expect(numbered.endsWith(" (2)")).toBe(true);
    expect([...numbered].length).toBe(120);
    // A typed name is still refused, and New message's own suggestion is still dropped.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "typed", to: claude, idempotency_key: "t", thread_name: name, thread_name_numbered: true }))).toBe("thread_name_taken");
    expect(store.startPersonThread({ project_id: project.id, body: "plain", to: claude, idempotency_key: "p", thread_name: name, thread_name_auto: true }).message.thread_name ?? null).toBeNull();
    // checkPersonThreadName (the trust path's check) agrees: a numbered suggestion never refuses.
    expect(() => store.checkPersonThreadName({ project_id: project.id, thread_name: name, thread_name_auto: true, thread_name_numbered: true })).not.toThrow();
  });

  test("a retried Send with a suggestion answers the first thread, even once the suggestion was dropped", () => {
    const { store, project } = world();
    store.startPersonThread({ project_id: project.id, body: "first", to: claude, idempotency_key: "k1", thread_name: "Relay budget" });
    const once = store.startPersonThread({ project_id: project.id, body: "second", to: claude, idempotency_key: "k2", thread_name: "Relay budget", thread_name_auto: true });
    const again = store.startPersonThread({ project_id: project.id, body: "second", to: claude, idempotency_key: "k2", thread_name: "Relay budget", thread_name_auto: true });
    expect(again.replayed).toBe(true);
    expect(again.message.id).toBe(once.message.id);
  });
});


describe("a retried reply whose `thread` could not name anything", () => {
  test("is the same call: `thread` is compared only where the reply could name the thread", () => {
    const { store, project } = world();
    // An agent's own thread: a reply's `thread` is ignored there.
    const root = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "status" }).message;
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "more", reply_to: root.id, thread: "One", idempotency_key: "r1" });
    const again = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "more", reply_to: root.id, thread: "Two", idempotency_key: "r1" });
    expect(again.replayed).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    // A person's thread already named: the reply could not name it either.
    const { message: person } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Board" });
    const r = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: person.id, idempotency_key: "r2" });
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: person.id, thread: "Other", idempotency_key: "r2" }).message.id).toBe(r.message.id);
  });
});
