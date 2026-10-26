/**
 * The Board's cards in the store (approval "inbox-board", step 1): the
 * column rules (COLUMNS.md, set d), last heard, an agent's drop waiting for
 * the person, links, idempotency, the one seq counter, and the round trip from
 * disk. The failures these guard: an agent pausing the person's work (Icebox),
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
  test("starts in Backlog, belongs to the agent that made it, and is heard now", () => {
    const { store, project } = world();
    const { card, replayed } = store.createCard({ project_id: project.id, by: AGENT, title: "  Hero   scene\ntimers ", say: "lane started" });
    expect(replayed).toBe(false);
    expect(card.id).toMatch(/^crd_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(card).toMatchObject({ title: "Hero scene timers", column: "backlog", said: "lane started", you: null, agent: AGENT, created_by: AGENT });
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

  test("a person's card belongs to no agent; only the person starts one in the Icebox; nobody starts one Dropped", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: PERSON, title: "Polylane evaluation", column: "icebox" });
    expect(card.agent).toBeNull();
    expect(card.column).toBe("icebox");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", column: "icebox" }))).toBe("card_icebox_person_only");
    expect(refusal(() => store.createCard({ project_id: project.id, by: PERSON, title: "x", column: "dropped" }))).toBe("validation_error");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", column: "later" }))).toBe("validation_error");
  });

  test("an agent that starts a card in the person's columns says what the person owes", () => {
    const { store, project } = world();
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Sheet", column: "your_look" }))).toBe("validation_error");
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Sheet", column: "your_look", you: "pick a face" });
    expect(card.you).toBe("pick a face");
    // `you` belongs to the person's columns only.
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "Code", column: "building", you: "merge it" }))).toBe("validation_error");
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

describe("cards: who moves a card (COLUMNS.md, set d)", () => {
  test("an agent moves its work through the live columns, ships it, and a re-report goes back to Backlog", () => {
    const { store, project, advance } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Delivery ticks" });
    advance(60_000);
    const building = store.updateCard(card.id, { by: AGENT, column: "building", say: "PR open", prs: ["backnotprop/plannotator#2016"] });
    expect(building.moved_at).not.toBe(card.moved_at);
    advance(60_000);
    const review = store.updateCard(card.id, { by: AGENT, column: "your_review", you: "screenshots before merge" });
    expect(review).toMatchObject({ column: "your_review", you: "screenshots before merge", said: "PR open" });
    const shipped = store.updateCard(card.id, { by: AGENT, column: "shipped" });
    // Leaving the person's columns drops their line: it never follows the card back.
    expect(shipped.you).toBeNull();
    expect(store.updateCard(card.id, { by: OTHER, column: "backlog", say: "reported broken again" }).column).toBe("backlog");
  });

  test("moving into the person's columns needs `you`, each time it enters them", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Favicon" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "your_look", say: "sheet sent" }))).toBe("validation_error");
    store.updateCard(card.id, { by: AGENT, column: "your_look", you: "pick a face" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "your_review" }))).toBe("validation_error");
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "building", you: "x" }))).toBe("validation_error");
    // A say in place keeps the line; the person moving it there needs none.
    expect(store.updateCard(card.id, { by: AGENT, say: "still waiting" }).you).toBe("pick a face");
    const moved = store.updateCard(card.id, { by: PERSON, column: "designing" });
    expect(moved.you).toBeNull();
    expect(store.updateCard(card.id, { by: PERSON, column: "your_review" }).you).toBeNull();
  });

  test("only the person puts a card in the Icebox or brings one back; an agent can still say and link", () => {
    const { store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Triage #1786", column: "designing" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "icebox" }))).toBe("card_icebox_person_only");
    const iced = store.updateCard(card.id, { by: PERSON, column: "icebox" });
    expect(iced).toMatchObject({ column: "icebox", aside_from: "designing" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "building" }))).toBe("card_iceboxed");
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, column: "dropped", reason: "moot" }))).toBe("card_iceboxed");
    expect(store.updateCard(card.id, { by: AGENT, say: "noted", prs: ["https://github.com/backnotprop/plannotator/pull/1786/files"] }).prs).toEqual([
      { ref: "backnotprop/plannotator#1786", url: "https://github.com/backnotprop/plannotator/pull/1786" },
    ]);
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, restore: true }))).toBe("card_person_only");
    const back = store.updateCard(card.id, { by: PERSON, restore: true });
    expect(back).toMatchObject({ column: "designing", aside_from: null });
  });

  test("an agent drops with a reason; only the person restores what they dropped", () => {
    const { store, project } = world();
    const mine = store.createCard({ project_id: project.id, by: AGENT, title: "vite 8", column: "building" }).card;
    expect(refusal(() => store.updateCard(mine.id, { by: AGENT, column: "dropped" }))).toBe("validation_error");
    const dropped = store.updateCard(mine.id, { by: AGENT, column: "dropped", reason: "folded into the Forge move" });
    expect(dropped.dropped).toMatchObject({ by: AGENT, reason: "folded into the Forge move" });
    expect(dropped.aside_from).toBe("building");
    // An agent may take back its own drop.
    expect(store.updateCard(mine.id, { by: AGENT, column: "building" })).toMatchObject({ column: "building", dropped: null });

    const theirs = store.createCard({ project_id: project.id, by: AGENT, title: "Polylane" }).card;
    const personDrop = store.updateCard(theirs.id, { by: PERSON, column: "dropped" });
    expect(personDrop.dropped).toMatchObject({ by: PERSON, reason: null });
    expect(refusal(() => store.updateCard(theirs.id, { by: AGENT, column: "backlog" }))).toBe("card_dropped_by_person");
    expect(store.updateCard(theirs.id, { by: PERSON, restore: true })).toMatchObject({ column: "backlog", dropped: null });
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
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Portless", column: "building" });
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
    store.updateCard(a.id, { by: AGENT, column: "backlog" });
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
    store.updateCard(card.id, { by: AGENT, column: "designing", say: "lane" });
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

  test("Asked was renamed Backlog (2026-10-26): a card stored as asked reads as backlog, and restores there; a caller saying asked lands in backlog", () => {
    const { store, project, dir } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Old ask" });
    store.updateCard(card.id, { by: PERSON, column: "icebox" });
    // Rewrite the lines as an Inbox from before the rename wrote them.
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const old = readFileSync(file, "utf8").replaceAll('"backlog"', '"asked"');
    expect(old).toContain('"asked"');
    writeFileSync(file, old);
    const reopened = InboxStore.open(dir);
    expect(reopened.card(card.id)).toMatchObject({ column: "icebox", aside_from: "backlog" });
    expect(reopened.updateCard(card.id, { by: PERSON, restore: true }).column).toBe("backlog");
    expect(reopened.updateCard(card.id, { by: AGENT, column: "designing" }).column).toBe("designing");
    expect(reopened.updateCard(card.id, { by: AGENT, column: "asked" }).column).toBe("backlog");
    expect(reopened.listCards({ columns: new Set(["backlog"]) }).map((c) => c.id)).toEqual([card.id]);
  });

  test("listCards: the Board's column order, the latest move first, and its filters", () => {
    const { store, project, advance } = world();
    const other = store.ensureProject({ name: "web", root: "/work/web" });
    const a = store.createCard({ project_id: project.id, by: AGENT, title: "a", column: "building" }).card;
    advance(1000);
    const b = store.createCard({ project_id: project.id, by: OTHER, title: "b", column: "building" }).card;
    const c = store.createCard({ project_id: project.id, by: AGENT, title: "c" }).card;
    const d = store.createCard({ project_id: other.id, by: AGENT, title: "d", column: "shipped" }).card;
    expect(store.listCards().map((card) => card.id)).toEqual([c.id, b.id, a.id, d.id]);
    expect(store.listCards({ projectIds: new Set([project.id]), columns: new Set(["building"]) }).map((card) => card.id)).toEqual([b.id, a.id]);
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
    expect(InboxStore.open(dir).card(card.id)!.refs).toEqual([{ kind: "pr", source: "github", ref: "acme/widgets#12", url: "https://github.com/acme/widgets/pull/12" }]);
  });

  test("history: every write the card saw, newest first, with who wrote it", () => {
    const { store, project, advance } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Ticks", column: "building" });
    advance(1000);
    store.updateCard(card.id, { by: AGENT, column: "your_review", you: "Merge #14" });
    advance(1000);
    store.updateCard(card.id, { by: PERSON, column: "shipped" });
    const history = store.cardHistory(card.id);
    expect(history[0]).toMatchObject({ kind: "moved", by: PERSON });
    expect(history.at(-1)!.kind).toBe("created");
    expect(store.cardHistory("crd_nope")).toEqual([]);
    // Two writes in one millisecond are two entries; the person seeing a drop is none.
    const quick = store.createCard({ project_id: project.id, by: AGENT, title: "Quick" }).card;
    store.updateCard(quick.id, { by: AGENT, column: "designing" });
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
    expect(sent.column).toBe("backlog");
    // Only through the person's addressed message, and only a Backlog card.
    const agents = store.sendMessage({ project_id: project.id, author: AGENT, body: "hi" });
    expect(refusal(() => store.sendCard(card.id, { thread_id: agents.message.id }))).toBe("validation_error");
    // The same send again (a retry after a lost answer) writes nothing.
    const lines = store.cardHistory(card.id).length;
    expect(store.sendCard(card.id, { thread_id: message.id })).toEqual(sent);
    expect(store.cardHistory(card.id)).toHaveLength(lines);
    store.updateCard(card.id, { by: OTHER, column: "building" });
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
    expect(made.card).toMatchObject({ column: "backlog", agent: { host: "pi", session: "ses_p" }, threads: [message.thread_id] });
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
