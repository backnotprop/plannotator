/**
 * The Board's cards in the store (approval "inbox-board", step 1; columns v2):
 * the column rules, last heard, an agent's drop waiting for the person,
 * links, idempotency, the one seq counter, the round trip from disk, the
 * read-time migration from the columns before v2, and the automatic ship.
 * The failures these guard: an agent starting work the person parked in
 * Backlog, an old card landing in the wrong lane after the upgrade,
 * a stale "You: …" following a card out of the person's columns, an agent's
 * drop the person never hears of, a "seen" that passes for news from the card,
 * a card line that breaks the event log's counter, and a card that does not
 * read back after a restart or a deletion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInboxCardDropUnseen, type InboxAuthor } from "@plannotator/core/inbox-types";
import { parseInboxCardPr } from "./cards";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-cards-"));
  roots.push(root);
  return root;
}

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const OTHER: InboxAuthor = { kind: "agent", host: "pi", session: "ses_b", name: "Pi" };
const PERSON: InboxAuthor = { kind: "person" };

/** A store whose clock the test moves. */
function world() {
  const dir = dataDir();
  let now = Date.parse("2026-10-20T12:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  return {
    dir,
    store,
    project,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("cards: create", () => {
  test("an agent's card starts in Todo, belongs to the agent that made it, and is heard now", () => {
    const { store, project } = world();
    const { card, replayed } = store.createCard({ project_id: project.id, by: AGENT, title: "  Hero   scene\ntimers ", say: "lane started" });
    expect(replayed).toBe(false);
    expect(card.id).toMatch(/^crd_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(card).toMatchObject({ title: "Hero scene timers", column: "todo", said: "lane started", you: null, agent: AGENT, created_by: AGENT, moved_by: AGENT });
    expect(card.heard_at).toBe(card.created_at);
    expect(card.moved_at).toBe(card.created_at);
  });

  test("from a thread: linked, and titled by the thread's subject", () => {
    const { store, project } = world();
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "Five hero options are ready.", subject: "Hero scene timers" });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, threads: [sent.message.id] });
    expect(card.title).toBe("Hero scene timers");
    expect(card.threads).toEqual([sent.message.thread_id]);
  });

  test("a default title from a thread's subject drops the bidi controls a title refuses (the agent never wrote them)", () => {
    const { store, project } = world();
    // A subject the agent sends with bidi controls is refused now; one derived from the body keeps them on disk.
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "Fix \u202eevil\u202c thing\u2066" });
    expect(store.message(sent.message.id)!.subject).toContain("\u202e");
    // Served as shown (displayInboxSubject): no bidi controls.
    expect(store.threadSubject(sent.message.thread_id)).toBe("Fix evil thing");
    expect(store.createCard({ project_id: project.id, by: AGENT, threads: [sent.message.id] }).card.title).toBe("Fix evil thing");
    // A title the agent writes itself is still refused, so it learns.
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Fix \u202eevil" }))).toBe("validation_error");
  });

  test("an idempotency_key is trimmed and at most 128 characters, one line", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "k", idempotency_key: "  " + "k".repeat(128) + " " });
    expect(card.idempotency_key).toBe("k".repeat(128));
    expect(store.createCard({ project_id: project.id, by: AGENT, title: "k", idempotency_key: "k".repeat(128) }).replayed).toBe(true);
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "k", idempotency_key: "k".repeat(129) }))).toBe("validation_error");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "k", idempotency_key: "a\nb" }))).toBe("validation_error");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "k", idempotency_key: 12 }))).toBe("validation_error");
  });

  test("a person's card belongs to no agent and starts in Backlog; the old Icebox id lands there; nobody starts one Dropped", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: PERSON, title: "Polylane evaluation" });
    expect(card).toMatchObject({ agent: null, column: "backlog", moved_by: PERSON });
    expect(store.createCard({ project_id: project.id, by: PERSON, title: "Old window", column: "icebox" }).card.column).toBe("backlog");
    // An agent proposing an idea may start one in Backlog; it is the agent's to move.
    const idea = store.createCard({ project_id: project.id, by: AGENT, title: "Idea", column: "backlog" }).card;
    expect(store.updateCard(idea.id, { by: AGENT, column: "in_progress" }).column).toBe("in_progress");
    expect(refusal(() => store.createCard({ project_id: project.id, by: PERSON, title: "x", column: "dropped" }))).toBe("validation_error");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", column: "later" }))).toBe("validation_error");
  });

  test("an agent that starts a card in In review says what the person owes", () => {
    const { store, project } = world();
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Sheet", column: "in_review" }))).toBe("validation_error");
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Sheet", column: "in_review", you: "pick a face" });
    expect(card.you).toBe("pick a face");
    // `you` belongs to In review only.
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Code", column: "in_progress", you: "merge it" }))).toBe("validation_error");
  });

  test("idempotent on its key per project; the same key with another title is refused", () => {
    const { store, project } = world();
    const first = store.createCard({ project_id: project.id, by: AGENT, title: "Pricing page", idempotency_key: "k1" });
    const again = store.createCard({ project_id: project.id, by: AGENT, title: "Pricing page", idempotency_key: "k1" });
    expect(again).toEqual({ card: first.card, replayed: true });
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Other", idempotency_key: "k1" }))).toBe("idempotency_key_reused");
    expect(store.listCards()).toHaveLength(1);
  });

  test("text is one line: whitespace collapses; control and bidi characters, empty and over-long text are refused", () => {
    const { store, project } = world();
    for (const title of ["", "   ", "a\u0007b", "x\u202ey", "t".repeat(121)]) {
      expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title }))).toBe("validation_error");
    }
    expect(store.createCard({ project_id: project.id, by: AGENT, title: "t".repeat(120) }).card.title).toHaveLength(120);
  });
});

describe("cards: who moves a card (columns v2)", () => {
  test("an agent moves its work through the live columns, ships it, and a re-report goes back to Todo", () => {
    const { store, project, advance } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Delivery ticks" });
    advance(60_000);
    const building = store.updateCard(card.id, { by: AGENT, column: "in_progress", say: "PR open", prs: ["backnotprop/plannotator#2016"] });
    expect(building.moved_at).not.toBe(card.moved_at);
    advance(60_000);
    const review = store.updateCard(card.id, { by: AGENT, column: "in_review", you: "screenshots before merge" });
    expect(review).toMatchObject({ column: "in_review", you: "screenshots before merge", said: "PR open" });
    const shipped = store.updateCard(card.id, { by: AGENT, column: "done" });
    // Leaving the person's columns drops their line: it never follows the card back.
    expect(shipped.you).toBeNull();
    expect(store.updateCard(card.id, { by: OTHER, column: "todo", say: "reported broken again" }).column).toBe("todo");
  });

  test("moving into In review needs `you`, each time it enters; a question mid-work leaves the card where it is", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Favicon" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "in_review", say: "sheet sent" }))).toBe("validation_error");
    store.updateCard(card.id, { by: AGENT, column: "in_review", you: "pick a face" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "in_progress", you: "x" }))).toBe("validation_error");
    // A say in place keeps the line; the person moving it there needs none.
    expect(store.updateCard(card.id, { by: AGENT, say: "still waiting" }).you).toBe("pick a face");
    const moved = store.updateCard(card.id, { by: PERSON, column: "in_progress" });
    expect(moved.you).toBeNull();
    expect(store.updateCard(card.id, { by: PERSON, column: "in_review" }).you).toBeNull();
  });

  test("old agents keep working: the column ids before v2 land in the v2 column", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Old agent", column: "asked" });
    expect(card.column).toBe("todo");
    const moves: [string, string][] = [["designing", "in_progress"], ["building", "in_progress"], ["To do", "todo"], ["In-Progress", "in_progress"], ["cancelled", "dropped"]];
    for (const [said, column] of moves) {
      const extra = column === "dropped" ? { reason: "moot" } : {};
      expect(store.updateCard(card.id, { by: AGENT, column: said, ...extra }).column).toBe(column);
      if (column === "dropped") store.updateCard(card.id, { by: AGENT, column: "todo" });
    }
    for (const said of ["your_look", "your_review"]) {
      expect(store.updateCard(card.id, { by: AGENT, column: said, you: "look" }).column).toBe("in_review");
      store.updateCard(card.id, { by: AGENT, column: "in_progress" });
    }
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "later" }))).toBe("validation_error");
  });

  test("a card the person put in Backlog is theirs to move out (the Icebox's guard); an agent can still say and link", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Triage #1786", column: "in_progress" });
    // An agent may park its own card in Backlog, and take it out again.
    expect(store.updateCard(card.id, { by: AGENT, column: "backlog" }).moved_by).toEqual(AGENT);
    store.updateCard(card.id, { by: AGENT, column: "in_progress" });
    // The person parks it: now only they move it out, to a lane or Cancelled.
    expect(store.updateCard(card.id, { by: PERSON, column: "backlog" })).toMatchObject({ column: "backlog", moved_by: PERSON });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "in_progress" }))).toBe("card_backlog_person_only");
    expect(refusal(() => store.updateCard(card.id, { by: OTHER, column: "dropped", reason: "moot" }))).toBe("card_backlog_person_only");
    expect(store.updateCard(card.id, { by: AGENT, say: "noted", prs: ["https://github.com/backnotprop/plannotator/pull/1786/files"] })).toMatchObject({
      column: "backlog",
      moved_by: PERSON,
      prs: [{ ref: "backnotprop/plannotator#1786", url: "https://github.com/backnotprop/plannotator/pull/1786" }],
    });
    // The person's Backlog idea, the same; their send makes it the agent's (Todo).
    const idea = store.createCard({ project_id: project.id, by: PERSON, title: "Polylane" }).card;
    expect(refusal(() => store.updateCard(idea.id, { by: AGENT, column: "todo" }))).toBe("card_backlog_person_only");
    expect(store.updateCard(card.id, { by: PERSON, column: "todo" }).moved_by).toEqual(PERSON);
    expect(store.updateCard(card.id, { by: AGENT, column: "in_progress" }).column).toBe("in_progress");
  });

  test("an agent drops with a reason; only the person restores what they dropped", () => {
    const { store, project } = world();
    const mine = store.createCard({ project_id: project.id, by: AGENT, title: "vite 8", column: "in_progress" }).card;
    expect(refusal(() => store.updateCard(mine.id, { by: AGENT, column: "dropped" }))).toBe("validation_error");
    const dropped = store.updateCard(mine.id, { by: AGENT, column: "dropped", reason: "folded into the Forge move" });
    expect(dropped.dropped).toMatchObject({ by: AGENT, reason: "folded into the Forge move" });
    expect(dropped.aside_from).toBe("in_progress");
    // An agent may take back its own drop.
    expect(store.updateCard(mine.id, { by: AGENT, column: "in_progress" })).toMatchObject({ column: "in_progress", dropped: null });

    const theirs = store.createCard({ project_id: project.id, by: AGENT, title: "Polylane" }).card;
    const personDrop = store.updateCard(theirs.id, { by: PERSON, column: "dropped" });
    expect(personDrop.dropped).toMatchObject({ by: PERSON, reason: null });
    expect(refusal(() => store.updateCard(theirs.id, { by: AGENT, column: "todo" }))).toBe("card_dropped_by_person");
    expect(store.updateCard(theirs.id, { by: PERSON, restore: true })).toMatchObject({ column: "todo", dropped: null });
    expect(refusal(() => store.updateCard(theirs.id, { by: PERSON, restore: true }))).toBe("validation_error");
    expect(refusal(() => store.updateCard(theirs.id, { by: AGENT, say: "x", reason: "why" }))).toBe("validation_error");
  });

  test("links: threads of the card's own project (message ids resolve to their thread), PRs by ref, each once", () => {
    const { store, project } = world();
    const other = store.ensureProject({ name: "web", root: "/work/web" });
    const here = store.sendMessage({ project_id: project.id, author: AGENT, body: "here" });
    const reply = store.sendMessage({ project_id: project.id, author: AGENT, body: "again", reply_to: here.message.id });
    const there = store.sendMessage({ project_id: other.id, author: AGENT, body: "there" });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Explorer" });
    const linked = store.updateCard(card.id, {
      by: AGENT,
      threads: [reply.message.id, here.message.id],
      prs: ["backnotprop/plannotator#1964", "https://github.com/backnotprop/plannotator/pull/1964"],
    });
    expect(linked.threads).toEqual([here.message.thread_id]);
    expect(linked.prs).toHaveLength(1);
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, threads: [there.message.id] }))).toBe("card_other_project");
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, threads: ["msg_00000000000000000000000000"] }))).toBe("thread_not_found");
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, prs: ["not a pr"] }))).toBe("validation_error");
    expect(refusal(() => store.updateCard(card.id, { by: AGENT }))).toBe("validation_error");
    expect(refusal(() => store.updateCard("crd_00000000000000000000000000", { by: AGENT, say: "x" }))).toBe("card_not_found");
  });
});

describe("cards: last heard, and an agent's drop reaching the person", () => {
  test("every write moves heard_at; nothing else is derived (no amber, no stall flag)", () => {
    const { store, project, advance, dir } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Portless", column: "in_progress" });
    advance(3 * 24 * 60 * 60 * 1000);
    const wire = store.cardWire(store.card(card.id)!);
    expect(wire.heard_at).toBe(card.heard_at);
    // Only `heard_seq` is added on the wire (a store seq, for the Board's unread rule): no amber, no stall flag.
    expect(Object.keys(wire).sort()).toEqual([...Object.keys(card), "heard_seq"].sort());
    expect(readFileSync(join(dir, "inbox", "projects", project.key, "cards.jsonl"), "utf8")).not.toMatch(/amber|stale/);
    const said = store.updateCard(card.id, { by: OTHER, say: "still on it" });
    expect(said.heard_at).not.toBe(card.heard_at);
    expect(said.heard_by).toEqual(OTHER);
  });

  test("an agent's drop is unseen until the person looks at Dropped; theirs is seen when made; looking writes once and is not news from the card", () => {
    const { store, project, advance } = world();
    const other = store.ensureProject({ name: "web", root: "/work/web" });
    const a = store.createCard({ project_id: project.id, by: AGENT, title: "vite 8" }).card;
    const b = store.createCard({ project_id: project.id, by: AGENT, title: "Polylane" }).card;
    const c = store.createCard({ project_id: other.id, by: AGENT, title: "Web" }).card;
    const dropA = store.updateCard(a.id, { by: AGENT, column: "dropped", reason: "folded into the Forge move" });
    expect(dropA.dropped).toMatchObject({ by: AGENT, reason: "folded into the Forge move", seen_at: null });
    expect(isInboxCardDropUnseen(dropA)).toBe(true);
    const dropB = store.updateCard(b.id, { by: PERSON, column: "dropped" });
    expect(dropB.dropped!.seen_at).toBe(dropB.dropped!.at);
    expect(isInboxCardDropUnseen(dropB)).toBe(false);
    store.updateCard(c.id, { by: AGENT, column: "dropped", reason: "moot" });

    advance(60_000);
    const seqs: number[] = [];
    store.subscribe((line) => seqs.push(line.seq));
    const marked = store.markCardDropsSeen(new Set([project.id]));
    expect(marked.map((card) => card.id)).toEqual([a.id]);
    expect(seqs).toHaveLength(1);
    const seen = store.card(a.id)!;
    expect(seen.dropped!.seen_at).not.toBeNull();
    // Looking is not hearing from the card.
    expect(seen.heard_at).toBe(dropA.heard_at);
    // The other project's drop still waits; looking again writes nothing.
    expect(isInboxCardDropUnseen(store.card(c.id)!)).toBe(true);
    expect(store.markCardDropsSeen(new Set([project.id]))).toEqual([]);
    expect(store.markCardDropsSeen().map((card) => card.id)).toEqual([c.id]);
    // A drop the agent makes again after a restore waits again.
    store.updateCard(a.id, { by: AGENT, column: "todo" });
    expect(isInboxCardDropUnseen(store.updateCard(a.id, { by: AGENT, column: "dropped", reason: "again" }))).toBe(true);
  });
});

describe("cards: on disk", () => {
  test("lines share the store's one seq counter, read back after a reopen, and outlive a thread's deletion", () => {
    const { store, project, dir } = world();
    const seqs: number[] = [];
    store.subscribe((line) => seqs.push(line.seq));
    const sent = store.sendMessage({ project_id: project.id, author: AGENT, body: "hi" });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "A card", threads: [sent.message.id] });
    store.updateCard(card.id, { by: AGENT, column: "in_progress", say: "lane" });
    store.sendMessage({ project_id: project.id, author: AGENT, body: "after" });
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    const cardLines = readFileSync(join(dir, "inbox", "projects", project.key, "cards.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((raw) => parseInboxLine(raw)!);
    expect(cardLines.map((line) => line.kind)).toEqual(["card", "card"]);
    // An older Inbox never reads cards.jsonl: the floor keeps the counter past the card lines.
    expect(JSON.parse(readFileSync(join(dir, "inbox", "seq.json"), "utf8")).seq).toBeGreaterThanOrEqual(cardLines[1]!.seq);
    const reopened = InboxStore.open(dir);
    expect(reopened.listCards()).toEqual(store.listCards());
    expect(reopened.cursor()).toBe(store.cursor());
    store.deleteThread(sent.message.thread_id);
    expect(store.card(card.id)).not.toBeNull();
    // The link to the deleted thread is not shown.
    expect(store.cardWire(store.card(card.id)!).threads).toEqual([]);
    expect(store.diskUsage().projects[0]!.bytes).toBeGreaterThan(0);
  });

  test("cards written before v2 read in the v2 columns, without a rewrite; the person's parked cards keep the guard", () => {
    const { store, project, dir } = world();
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const make = (title: string, by: InboxAuthor) => store.createCard({ project_id: project.id, by, title }).card;
    // The cards as an Inbox before v2 wrote them: its ids, no `cols`, no `moved_by`.
    const old: [ReturnType<typeof make>, Record<string, unknown>, string, InboxAuthor | null][] = [
      [make("asked of an agent", AGENT), { column: "backlog" }, "todo", AGENT],
      [make("an older rename", AGENT), { column: "asked" }, "todo", AGENT],
      [make("the person's idea", PERSON), { column: "backlog" }, "backlog", PERSON],
      [make("designing", AGENT), { column: "designing" }, "in_progress", AGENT],
      [make("your look", AGENT), { column: "your_look", you: "pick" }, "in_review", AGENT],
      [make("building", AGENT), { column: "building" }, "in_progress", AGENT],
      [make("your review", AGENT), { column: "your_review", you: "merge" }, "in_review", AGENT],
      [make("iced", AGENT), { column: "icebox", aside_from: "building" }, "backlog", PERSON],
      [make("shipped", AGENT), { column: "shipped" }, "done", AGENT],
      [make("dropped", AGENT), { column: "dropped", aside_from: "backlog", dropped: { at: "2026-10-20T12:00:00.000Z", by: AGENT, reason: "x", seen_at: null } }, "dropped", AGENT],
    ];
    const lines = readFileSync(file, "utf8").trim().split("\n").map((raw) => JSON.parse(raw));
    for (const line of lines) {
      const [, patch] = old.find(([card]) => card.id === line.record.id)!;
      Object.assign(line.record, patch);
      delete line.record.cols;
      delete line.record.moved_by;
    }
    const written = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    writeFileSync(file, written);
    const reopened = InboxStore.open(dir);
    for (const [card, , column, movedBy] of old) expect(reopened.card(card.id), card.title).toMatchObject({ column, moved_by: movedBy });
    // Restoring the dropped card goes where its old column reads now (an agent's Backlog card: Todo).
    const dropped = old.at(-1)![0];
    expect(reopened.card(dropped.id)!.aside_from).toBe("todo");
    // The file is read, never rewritten.
    expect(readFileSync(file, "utf8")).toBe(written);
    // The iced card is the person's: an agent cannot take it out of Backlog.
    const iced = old[7]![0];
    expect(refusal(() => reopened.updateCard(iced.id, { by: AGENT, column: "in_progress" }))).toBe("card_backlog_person_only");
    // Its next write is v2, and reads back the same.
    const next = reopened.updateCard(iced.id, { by: PERSON, column: "todo" });
    const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!);
    expect(last.record).toMatchObject({ cols: 2, column: "todo", moved_by: PERSON });
    expect(InboxStore.open(dir).card(iced.id)).toMatchObject({ column: next.column, moved_by: PERSON });
  });

  test("a v2 line with an id an older Inbox wrote (after a downgrade and back) still reads through the aliases", () => {
    const { store, project, dir } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Round trip" });
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"column":"todo"', '"column":"building"'));
    expect(InboxStore.open(dir).card(card.id)!.column).toBe("in_progress");
  });

  test("a v2 line from before Done's rename (`shipped`, owner 2026-11-02) reads as Done, with no rewrite; Restore goes back to Done", () => {
    const { store, project, dir } = world();
    const shipped = store.createCard({ project_id: project.id, by: AGENT, title: "Shipped before", column: "done" }).card;
    const cancelled = store.createCard({ project_id: project.id, by: AGENT, title: "Cancelled from shipped", column: "done" }).card;
    store.updateCard(cancelled.id, { by: PERSON, column: "dropped" });
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const written = readFileSync(file, "utf8").replaceAll('"column":"done"', '"column":"shipped"').replaceAll('"aside_from":"done"', '"aside_from":"shipped"');
    expect(written).toContain('"shipped"');
    writeFileSync(file, written);
    const reopened = InboxStore.open(dir);
    expect(reopened.card(shipped.id)!.column).toBe("done");
    expect(reopened.card(cancelled.id)!.aside_from).toBe("done");
    expect(readFileSync(file, "utf8")).toBe(written);
    expect(reopened.updateCard(cancelled.id, { by: PERSON, restore: true }).column).toBe("done");
    // An agent with the old id moves a card to Done.
    const live = reopened.createCard({ project_id: project.id, by: AGENT, title: "Old agent", column: "in_progress" }).card;
    expect(reopened.updateCard(live.id, { by: AGENT, column: "shipped" as never }).column).toBe("done");
  });

  test("listCards: the Board's column order, the latest move first, and its filters", () => {
    const { store, project, advance } = world();
    const other = store.ensureProject({ name: "web", root: "/work/web" });
    const a = store.createCard({ project_id: project.id, by: AGENT, title: "a", column: "in_progress" }).card;
    advance(1000);
    const b = store.createCard({ project_id: project.id, by: OTHER, title: "b", column: "in_progress" }).card;
    const c = store.createCard({ project_id: project.id, by: AGENT, title: "c" }).card;
    const d = store.createCard({ project_id: other.id, by: AGENT, title: "d", column: "done" }).card;
    expect(store.listCards().map((card) => card.id)).toEqual([c.id, b.id, a.id, d.id]);
    expect(store.listCards({ projectIds: new Set([project.id]), columns: new Set(["in_progress"]) }).map((card) => card.id)).toEqual([b.id, a.id]);
    expect(store.listCards({ agentSession: "ses_b" }).map((card) => card.id)).toEqual([b.id]);
  });
});

describe("parseInboxCardPr", () => {
  test("shorthand and the review's PR URLs, canonical; anything else is no PR", () => {
    expect(parseInboxCardPr("owner/repo#0123")).toEqual({ ref: "owner/repo#123", url: "https://github.com/owner/repo/pull/123" });
    expect(parseInboxCardPr("https://gitlab.com/g/sub/p/-/merge_requests/12/diffs")).toEqual({ ref: "g/sub/p!12", url: "https://gitlab.com/g/sub/p/-/merge_requests/12" });
    expect(parseInboxCardPr("https://bitbucket.org/ws/r/pull-requests/7")).toEqual({ ref: "ws/r#7", url: "https://bitbucket.org/ws/r/pull-requests/7" });
    expect(parseInboxCardPr("https://ghe.corp/o/r/pull/5")).toEqual({ ref: "ghe.corp/o/r#5", url: "https://ghe.corp/o/r/pull/5" });
    for (const bad of ["#12", "PR 12", "https://github.com/o/r/issues/1", "", 12, null]) expect(parseInboxCardPr(bad)).toBeNull();
  });
});

describe("cards: the Board page's fields (step 2)", () => {
  test("notes: the person's, line breaks kept, capped; cleared with an empty value", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: PERSON, title: "Roadmap page", notes: "  One page.\n\nWhat is next.  " });
    expect(card.notes).toBe("One page.\n\nWhat is next.");
    expect(store.updateCard(card.id, { by: PERSON, notes: "" }).notes).toBeNull();
    expect(refusal(() => store.updateCard(card.id, { by: PERSON, notes: "x".repeat(4001) }))).toBe("validation_error");
  });

  test("links: an issue and a PR as refs, the PRs still written as prs for an older Inbox; a stored prs-only card reads its refs", () => {
    const { dir, store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Forge", prs: ["acme/widgets#12"], refs: ["acme/widgets#11", "https://github.com/acme/widgets/pull/12"] });
    expect(card.refs.map((ref) => [ref.kind, ref.ref])).toEqual([
      ["pr", "acme/widgets#12"],
      ["issue", "acme/widgets#11"],
    ]);
    expect(card.prs).toEqual([{ ref: "acme/widgets#12", url: "https://github.com/acme/widgets/pull/12" }]);
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, refs: ["https://evil.example/o/r/issues/1"] }))).toBe("validation_error");
    // A record from step 1 (prs, no refs) reads its PRs as refs.
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    delete lines.at(-1).record.refs;
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    // Linked as `prs` then, so each is the card's own PR (`via: "pr"`).
    expect(InboxStore.open(dir).card(card.id)!.refs).toEqual([{ kind: "pr", source: "github", ref: "acme/widgets#12", url: "https://github.com/acme/widgets/pull/12", via: "pr" }]);
  });

  test("history: every write the card saw, newest first, with who wrote it", () => {
    const { store, project, advance } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Ticks", column: "in_progress" });
    advance(1000);
    store.updateCard(card.id, { by: AGENT, column: "in_review", you: "Merge #14" });
    advance(1000);
    store.updateCard(card.id, { by: PERSON, column: "done" });
    const history = store.cardHistory(card.id);
    expect(history[0]).toMatchObject({ kind: "moved", by: PERSON });
    expect(history.at(-1)!.kind).toBe("created");
    expect(store.cardHistory("crd_nope")).toEqual([]);
    // Two writes in one millisecond are two entries; the person seeing a drop is none.
    const quick = store.createCard({ project_id: project.id, by: AGENT, title: "Quick" }).card;
    store.updateCard(quick.id, { by: AGENT, column: "in_progress" });
    store.updateCard(quick.id, { by: AGENT, column: "dropped", reason: "superseded" });
    expect(store.cardHistory(quick.id).map((entry) => entry.kind)).toEqual(["dropped", "moved", "created"]);
    store.markCardDropsSeen();
    expect(store.cardHistory(quick.id).map((entry) => entry.kind)).toEqual(["dropped", "moved", "created"]);
  });

  test("sent: the person's card goes to an agent through a thread they started; it is that agent's, and says so until it moves", () => {
    const { store, project, advance } = world();
    const to = { host: "codex", session: "ses_x" };
    const { card } = store.createCard({ project_id: project.id, by: PERSON, title: "Retry budget" });
    const { message } = store.startPersonThread({ project_id: project.id, body: "Retry budget", to, idempotency_key: "k1" });
    advance(1000);
    const sent = store.sendCard(card.id, { thread_id: message.id });
    expect(sent.agent).toMatchObject({ kind: "agent", host: "codex", session: "ses_x", name: "Codex" });
    expect(sent.sent).toMatchObject({ to: { host: "codex", session: "ses_x" }, thread_id: message.thread_id });
    expect(sent.threads).toEqual([message.thread_id]);
    expect(sent.heard_by).toEqual(PERSON);
    // Sending asks the agent to do it: Todo, moved by the person.
    expect(sent).toMatchObject({ column: "todo", moved_by: PERSON });
    // Only through the person's addressed message, and only a Backlog or Todo card.
    const agents = store.sendMessage({ project_id: project.id, author: AGENT, body: "hi" });
    expect(refusal(() => store.sendCard(card.id, { thread_id: agents.message.id }))).toBe("validation_error");
    // The same send again (a retry after a lost answer) writes nothing.
    const lines = store.cardHistory(card.id).length;
    expect(store.sendCard(card.id, { thread_id: message.id })).toEqual(sent);
    expect(store.cardHistory(card.id)).toHaveLength(lines);
    store.updateCard(card.id, { by: OTHER, column: "in_progress" });
    expect(refusal(() => store.sendCard(card.id, { thread_id: message.id }))).toBe("validation_error");
  });

  test("create and send in one op: a thread that is not the person's leaves no card; a key replays, sending a card it made unsent", () => {
    const { store, project } = world();
    const agents = store.sendMessage({ project_id: project.id, author: AGENT, body: "mine" });
    const before = store.listCards().length;
    expect(refusal(() => store.createCard({ project_id: project.id, by: PERSON, title: "Wrong", send_thread_id: agents.message.id, idempotency_key: "k" }))).toBe("validation_error");
    expect(store.listCards()).toHaveLength(before);
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Agent", send_thread_id: agents.message.id }))).toBe("validation_error");
    const { message } = store.startPersonThread({ project_id: project.id, body: "Go", to: { host: "pi", session: "ses_p" }, idempotency_key: "m" });
    const made = store.createCard({ project_id: project.id, by: PERSON, title: "Go", send_thread_id: message.id, idempotency_key: "k" });
    expect(made.card).toMatchObject({ column: "todo", agent: { host: "pi", session: "ses_p" }, threads: [message.thread_id] });
    expect(made.card.sent).toMatchObject({ thread_id: message.thread_id });
    expect(store.cardHistory(made.card.id).map((h) => h.kind)).toEqual(["sent", "created"]);
    const again = store.createCard({ project_id: project.id, by: PERSON, title: "Go", send_thread_id: message.id, idempotency_key: "k" });
    expect(again).toMatchObject({ replayed: true, card: { id: made.card.id } });
    // A card a key made unsent (the window's card-first Send, interrupted) is sent by the retry.
    const first = store.createCard({ project_id: project.id, by: PERSON, title: "Later", idempotency_key: "k2" }).card;
    const second = store.startPersonThread({ project_id: project.id, body: "Later", to: { host: "pi", session: "ses_p" }, idempotency_key: "m2" });
    const sentNow = store.createCard({ project_id: project.id, by: PERSON, title: "Later", send_thread_id: second.message.id, idempotency_key: "k2" });
    expect(sentNow).toMatchObject({ replayed: true, card: { id: first.id, sent: { thread_id: second.message.thread_id } } });
  });

  test("heard_seq: the line of the last write; a seen mark is not one; two writes in one millisecond differ", () => {
    const { store, project } = world();
    const a = store.createCard({ project_id: project.id, by: AGENT, title: "A" }).card;
    const b = store.createCard({ project_id: project.id, by: AGENT, title: "B" }).card;
    const seqA = store.cardWire(store.card(a.id)!).heard_seq!;
    const seqB = store.cardWire(store.card(b.id)!).heard_seq!;
    expect(seqB).toBeGreaterThan(seqA);
    expect(store.card(a.id)!.heard_at).toBe(store.card(b.id)!.heard_at);
    store.updateCard(a.id, { by: AGENT, column: "dropped", reason: "gone" });
    const dropped = store.cardWire(store.card(a.id)!).heard_seq!;
    expect(dropped).toBeGreaterThan(seqB);
    store.markCardDropsSeen();
    expect(store.cardWire(store.card(a.id)!).heard_seq).toBe(dropped);
    // The same after a reload from disk.
    expect(InboxStore.open(store.dir.replace(/\/inbox$/, "")).cardWire(store.card(a.id)!).heard_seq).toBe(dropped);
  });
});

describe("cards: to Done by itself (v2, Q3)", () => {
  const PR1 = "https://github.com/acme/widgets/pull/12";
  const PR2 = "https://github.com/acme/widgets/pull/13";

  test("every linked PR merged: Done, once for that PR set; the person moving it back is final for it", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Forge", column: "in_review", you: "merge", prs: [PR1, PR2] });
    // One PR merged, the other not known merged: nothing.
    expect(store.autoShipCard(card.id, [PR1])).toBeNull();
    expect(store.card(card.id)!.column).toBe("in_review");
    const shipped = store.autoShipCard(card.id, [PR1, PR2])!;
    expect(shipped).toMatchObject({ column: "done", you: null, moved_by: PERSON, heard_by: PERSON, auto_shipped: { prs: [PR1, PR2] } });
    expect(store.cardHistory(card.id)[0]).toMatchObject({ kind: "auto_shipped", prs: [PR1, PR2] });
    // Already shipped: nothing more.
    expect(store.autoShipCard(card.id, [PR1, PR2])).toBeNull();
    // The person moves it back: the same PRs never ship it again.
    store.updateCard(card.id, { by: PERSON, column: "in_progress" });
    expect(store.autoShipCard(card.id, [PR1, PR2])).toBeNull();
    expect(store.card(card.id)!.column).toBe("in_progress");
    // A new PR linked and merged is a new set: it ships again.
    const PR3 = "https://github.com/acme/widgets/pull/14";
    store.updateCard(card.id, { by: AGENT, prs: [PR3] });
    expect(store.autoShipCard(card.id, [PR1, PR2, PR3])!.column).toBe("done");
  });

  test("only Todo, In progress and In review ship; a card with no PR, or one gone, never does", () => {
    const { store, project } = world();
    const parked = store.createCard({ project_id: project.id, by: PERSON, title: "Idea", prs: [PR1] }).card;
    expect(parked.column).toBe("backlog");
    expect(store.autoShipCard(parked.id, [PR1])).toBeNull();
    const plain = store.createCard({ project_id: project.id, by: AGENT, title: "No PR" }).card;
    expect(store.autoShipCard(plain.id, [PR1])).toBeNull();
    const cancelled = store.createCard({ project_id: project.id, by: AGENT, title: "Gone", prs: [PR1] }).card;
    store.updateCard(cancelled.id, { by: AGENT, column: "dropped", reason: "moot" });
    expect(store.autoShipCard(cancelled.id, [PR1])).toBeNull();
    expect(store.autoShipCard("crd_00000000000000000000000000", [PR1])).toBeNull();
    const todo = store.createCard({ project_id: project.id, by: AGENT, title: "Asked", prs: [PR1] }).card;
    expect(store.autoShipCard(todo.id, [PR1])!.column).toBe("done");
  });

  // Review of #2522, finding 1: what regresses is a card moved out of Done by the person (or "reported
  // broken again") that moves itself back to Done on the next Board view.
  test("shipped by hand, then moved back: its PRs never move it to Done again; a PR merged since does", () => {
    const { store, project } = world();
    const byAgent = store.createCard({ project_id: project.id, by: AGENT, title: "Agent ship", column: "in_progress", prs: [PR1] }).card;
    store.updateCard(byAgent.id, { by: AGENT, column: "done" });
    // Reported broken again: the agent moves it back, as the tool text says.
    store.updateCard(byAgent.id, { by: AGENT, column: "todo" });
    expect(store.autoShipCard(byAgent.id, [PR1])).toBeNull();
    const byPerson = store.createCard({ project_id: project.id, by: AGENT, title: "Person ship", column: "in_review", you: "merge", prs: [PR1] }).card;
    store.updateCard(byPerson.id, { by: PERSON, column: "done" });
    store.updateCard(byPerson.id, { by: PERSON, column: "in_progress" });
    expect(store.autoShipCard(byPerson.id, [PR1])).toBeNull();
    // Made in Done, moved out: the same.
    const made = store.createCard({ project_id: project.id, by: AGENT, title: "Made done", column: "done", prs: [PR1] }).card;
    store.updateCard(made.id, { by: PERSON, column: "in_progress" });
    expect(store.autoShipCard(made.id, [PR1])).toBeNull();
    // A fix PR, merged: it moves to Done by itself.
    store.updateCard(byAgent.id, { by: AGENT, prs: [PR2] });
    expect(store.autoShipCard(byAgent.id, [PR1, PR2])!.column).toBe("done");
  });

  test("a line from before done_prs: a card shipped and moved back then stays where it is after the upgrade", () => {
    const { store, project, dir } = world();
    const card = store.createCard({ project_id: project.id, by: AGENT, title: "Old ship", column: "in_progress", prs: [PR1] }).card;
    store.updateCard(card.id, { by: AGENT, column: "done" });
    store.updateCard(card.id, { by: PERSON, column: "in_progress" });
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((raw) => JSON.parse(raw));
    for (const line of lines) delete line.record.done_prs;
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(readFileSync(file, "utf8")).not.toContain("done_prs");
    expect(InboxStore.open(dir).autoShipCard(card.id, [PR1])).toBeNull();
  });

  // Review of #2522, D1: a released Inbox wrote links with no `via` and no `done_prs`. Read as context they
  // gave an empty list, and an agent re-giving the PR as its own `pr` moved the card back to Done.
  test("a released-format line (links with no via, no done_prs): shipped and moved back, a PR re-given as pr never moves it again", () => {
    const { store, project, dir } = world();
    const card = store.createCard({ project_id: project.id, by: AGENT, title: "Released ship", column: "in_progress", prs: [PR1] }).card;
    store.updateCard(card.id, { by: AGENT, column: "done" });
    store.updateCard(card.id, { by: PERSON, column: "in_progress" });
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((raw) => JSON.parse(raw));
    for (const line of lines) {
      delete line.record.done_prs;
      for (const ref of line.record.refs ?? []) delete ref.via;
    }
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(readFileSync(file, "utf8")).not.toMatch(/done_prs|"via"/);
    const reopened = InboxStore.open(dir);
    expect(reopened.card(card.id)!.done_prs).toEqual([PR1]);
    // The agent hands it over again, giving the same PR as its own (the tool text's move takes pr).
    reopened.updateCard(card.id, { by: AGENT, column: "in_review", you: "merge", prs: [PR1] });
    expect(reopened.autoShipCard(card.id, [PR1])).toBeNull();
    expect(reopened.card(card.id)!.column).toBe("in_review");
    // A line in Done keeps a stale list an older Inbox carried along, joined with every PR it links.
    const stale = reopened.createCard({ project_id: project.id, by: AGENT, title: "Stale list", column: "in_progress", prs: [PR2] }).card;
    reopened.updateCard(stale.id, { by: AGENT, column: "done" });
    const all = readFileSync(file, "utf8").trim().split("\n").map((raw) => JSON.parse(raw));
    all.at(-1)!.record.done_prs = [PR1];
    writeFileSync(file, `${all.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(InboxStore.open(dir).card(stale.id)!.done_prs).toEqual([PR1, PR2]);
  });

  // Review of #2522, D2: each writer puts the list in the line it writes (the load only backs up older lines).
  test("every move into Done writes done_prs into its own line: made in Done, moved there, moved there by the Inbox", () => {
    const { store, project, dir } = world();
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const lastLine = () => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).record;
    store.createCard({ project_id: project.id, by: AGENT, title: "Made done", column: "done", prs: [PR1], refs: [PR2] });
    expect(lastLine().done_prs).toEqual([PR1, PR2]);
    const moved = store.createCard({ project_id: project.id, by: AGENT, title: "Moved", column: "in_progress", prs: [PR1] }).card;
    store.updateCard(moved.id, { by: PERSON, column: "done" });
    expect(lastLine().done_prs).toEqual([PR1]);
    const auto = store.createCard({ project_id: project.id, by: AGENT, title: "Auto", column: "in_review", you: "merge", prs: [PR2], refs: [PR1] }).card;
    store.autoShipCard(auto.id, [PR2]);
    expect(lastLine()).toMatchObject({ column: "done", auto_shipped: { prs: [PR2] }, done_prs: [PR1, PR2] });
  });

  // Review of #2522, finding 2 (the coordinator's call): only the card's own PRs, linked through `pr`, count.
  test("a PR linked through ref is context: merged, it never moves the card; given as the card's pr, it does", () => {
    const { store, project } = world();
    const context = store.createCard({ project_id: project.id, by: AGENT, title: "Follow-up", refs: [PR1] }).card;
    expect(store.autoShipCard(context.id, [PR1])).toBeNull();
    const mixed = store.createCard({ project_id: project.id, by: AGENT, title: "Own PR", column: "in_progress", prs: [PR2], refs: [PR1] }).card;
    // Its own PR not merged yet: the merged context PR does nothing.
    expect(store.autoShipCard(mixed.id, [PR1])).toBeNull();
    expect(store.autoShipCard(mixed.id, [PR1, PR2])).toMatchObject({ column: "done", auto_shipped: { prs: [PR2] } });
    // The context PR given later as the card's own: it counts from then on.
    store.updateCard(context.id, { by: AGENT, prs: [PR1] });
    expect(store.autoShipCard(context.id, [PR1])!.column).toBe("done");
  });
});
