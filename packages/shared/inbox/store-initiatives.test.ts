/**
 * The Board's initiatives in the store (approval "board-initiatives"). The
 * failures these guard: an initiative or a card's initiative that does not
 * read back after a restart; a card line written before initiatives (or by an
 * older Inbox) that breaks or loses the card's initiative; a deleted
 * initiative that keeps its cards out of "No initiative", or rewrites every
 * card (their ages reset); an initiative line that reuses a seq; an agent
 * that sets one; two initiatives with one name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_RECORD_VERSION, type InboxAuthor, type InboxCard } from "@plannotator/core/inbox-types";
import { InboxError, parseInboxLine } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-initiatives-"));
  roots.push(dir);
  let now = Date.parse("2026-11-04T12:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  return { dir, store, project, advance: (ms: number) => (now += ms) };
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

describe("initiatives: the store", () => {
  test("made, renamed, set on a card: all read back from disk after a restart, on the one seq", () => {
    const { dir, store, project } = world();
    const review = store.createInitiative({ name: "  Code   review ", by: PERSON });
    expect(review.id).toMatch(/^ini_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(review.name).toBe("Code review");
    const { card } = store.createCard({ project_id: project.id, by: PERSON, title: "Hover cards", initiative: review.id });
    expect(card.initiative).toBe(review.id);
    const other = store.createCard({ project_id: project.id, by: AGENT, title: "Diff wrap" }).card;
    store.setCardInitiative(other.id, review.id, PERSON);
    store.renameInitiative(review.id, "Review");

    // One counter: the initiative lines sit among the card lines, never sharing a seq.
    const seqs = [
      ...readFileSync(join(dir, "inbox", "initiatives.jsonl"), "utf8").split("\n"),
      ...readFileSync(join(dir, "inbox", "projects", project.key, "cards.jsonl"), "utf8").split("\n"),
    ]
      .map((raw) => parseInboxLine(raw)?.seq)
      .filter((seq): seq is number => typeof seq === "number");
    expect(new Set(seqs).size).toBe(seqs.length);

    const again = InboxStore.open(dir);
    expect(again.initiatives().map((i) => [i.id, i.name, i.deleted_at])).toEqual([[review.id, "Review", null]]);
    expect(again.cardWire(again.card(card.id)!).initiative).toBe(review.id);
    expect(again.cardWire(again.card(other.id)!).initiative).toBe(review.id);
    // The next write takes a seq after every line read, the initiatives' included.
    const before = again.cursor();
    const later = again.createInitiative({ name: "Shape", by: PERSON });
    expect(again.cursor()).toBe(before + 1);
    expect(later.name).toBe("Shape");
  });

  test("a card line from before initiatives reads as in none, and an older Inbox's later line keeps the card's initiative", () => {
    const { dir, store, project } = world();
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Old card" });
    const file = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    // A line exactly as an Inbox before initiatives wrote it: no `initiative` field at all.
    const raw = JSON.parse(readFileSync(file, "utf8").trim().split("\n").pop()!) as { record: InboxCard };
    delete raw.record.initiative;
    const old = { ...raw.record, said: "still going" };
    appendFileSync(file, `${JSON.stringify({ v: INBOX_RECORD_VERSION, seq: store.cursor() + 1, at: old.heard_at, kind: "card", id: old.id, record: old })}\n`);
    const reread = InboxStore.open(dir);
    expect(reread.card(card.id)!.initiative).toBeNull();
    expect(reread.cardWire(reread.card(card.id)!).initiative).toBeNull();

    // Put in one now, then an older Inbox writes the card again without the field: it keeps its initiative.
    const shape = reread.createInitiative({ name: "Shape", by: PERSON });
    reread.setCardInitiative(card.id, shape.id, PERSON);
    const latest = { ...reread.card(card.id)!, said: "older inbox wrote this" } as InboxCard;
    delete latest.initiative;
    appendFileSync(file, `${JSON.stringify({ v: INBOX_RECORD_VERSION, seq: reread.cursor() + 1, at: latest.heard_at, kind: "card", id: latest.id, record: latest })}\n`);
    const third = InboxStore.open(dir);
    expect(third.card(card.id)!.said).toBe("older inbox wrote this");
    expect(third.card(card.id)!.initiative).toBe(shape.id);
    // The event for that raw line (cardWire of the line's record, as eventPayload sends it) carries the kept one too.
    expect(third.cardWire(latest).initiative).toBe(shape.id);
    // And its history does not say the initiative was cleared.
    expect(third.cardHistory(card.id).filter((entry) => entry.kind === "initiative")).toEqual([
      { at: expect.any(String), by: PERSON, kind: "initiative", initiative: shape.id },
    ]);
  });

  test("deleting an initiative puts its cards in No initiative without writing them, and frees its name", () => {
    const { dir, store, project, advance } = world();
    const memory = store.createInitiative({ name: "Memory", by: PERSON });
    const a = store.createCard({ project_id: project.id, by: PERSON, title: "Recall ranking", initiative: memory.id }).card;
    const b = store.createCard({ project_id: project.id, by: PERSON, title: "Forget on request", initiative: memory.id }).card;
    const cardsFile = join(dir, "inbox", "projects", project.key, "cards.jsonl");
    const linesBefore = readFileSync(cardsFile, "utf8");
    advance(60_000);
    const gone = store.deleteInitiative(memory.id);
    expect(gone.deleted_at).not.toBeNull();
    // No card line written: their last-heard ages stay.
    expect(readFileSync(cardsFile, "utf8")).toBe(linesBefore);
    for (const id of [a.id, b.id]) {
      expect(store.cardWire(store.card(id)!).initiative).toBeNull();
      expect(store.card(id)!.heard_at).toBe(a.heard_at);
    }
    // The record stays (the history names it); it is no longer one to pick.
    expect(store.initiatives().find((i) => i.id === memory.id)?.deleted_at).toBe(gone.deleted_at);
    expect(refusal(() => store.setCardInitiative(a.id, memory.id, PERSON))).toBe("initiative_not_found");
    expect(refusal(() => store.renameInitiative(memory.id, "Again"))).toBe("initiative_not_found");
    // Its name is free again.
    expect(store.createInitiative({ name: "memory", by: PERSON }).name).toBe("memory");
    // After a restart too.
    const again = InboxStore.open(dir);
    expect(again.cardWire(again.card(a.id)!).initiative).toBeNull();
    expect(again.cardHistory(a.id)[0]).toMatchObject({ kind: "created" });
  });

  test("setting one: the person only, a live one only, a history line each way, and the same one twice writes nothing", () => {
    const { store, project } = world();
    const release = store.createInitiative({ name: "Release", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Changelog" });
    expect(refusal(() => store.setCardInitiative(card.id, release.id, AGENT))).toBe("initiative_person_only");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", initiative: release.id }))).toBe("initiative_person_only");
    expect(refusal(() => store.createInitiative({ name: "Mine", by: AGENT }))).toBe("initiative_person_only");
    expect(refusal(() => store.setCardInitiative(card.id, "ini_01JX0000000000000000000000", PERSON))).toBe("initiative_not_found");

    const set = store.setCardInitiative(card.id, release.id, PERSON);
    expect(set.initiative).toBe(release.id);
    const cursor = store.cursor();
    store.setCardInitiative(card.id, release.id, PERSON);
    expect(store.cursor()).toBe(cursor);
    store.setCardInitiative(card.id, null, PERSON);
    expect(store.card(card.id)!.initiative).toBeNull();
    expect(store.cardHistory(card.id).filter((entry) => entry.kind === "initiative").map((entry) => (entry.kind === "initiative" ? entry.initiative : "?"))).toEqual([
      null,
      release.id,
    ]);
    // An agent's later write keeps what the person set.
    store.setCardInitiative(card.id, release.id, PERSON);
    store.updateCard(card.id, { by: AGENT, say: "drafted" });
    expect(store.card(card.id)!.initiative).toBe(release.id);
  });

  test("names: one line, at most 40 characters, and unique among the live ones ignoring case", () => {
    const { store } = world();
    const shape = store.createInitiative({ name: "Shape", by: PERSON });
    expect(refusal(() => store.createInitiative({ name: " shape ", by: PERSON }))).toBe("initiative_exists");
    expect(refusal(() => store.createInitiative({ name: "", by: PERSON }))).toBe("validation_error");
    expect(refusal(() => store.createInitiative({ name: "x".repeat(41), by: PERSON }))).toBe("validation_error");
    const other = store.createInitiative({ name: "Memory", by: PERSON });
    expect(refusal(() => store.renameInitiative(other.id, "SHAPE"))).toBe("initiative_exists");
    // Renaming one to its own name in other case is fine.
    expect(store.renameInitiative(shape.id, "SHAPE").name).toBe("SHAPE");
  });
});

// Approval "board-initiatives", "Agents and initiatives" (q-b3b9c89c): an agent puts its card in an initiative by
// name (the card tool's `initiative`, here `initiative_name`), and makes one only that way. The failures guarded: a
// near-duplicate made for a name that differs only in case, spaces or punctuation; a refused card that leaves an initiative
// behind; the name rules skipped for agents; a cap back on how many there are; a deleted initiative taking its cards with it.
describe("initiatives: an agent's card names one", () => {
  test("an existing name joins it; an unknown one makes it; \"\" takes the card out", () => {
    const { store, project } = world();
    const review = store.createInitiative({ name: "Code review", by: PERSON });
    const joined = store.createCard({ project_id: project.id, by: AGENT, title: "Diff wrap", initiative_name: "  CODE review " }).card;
    expect(joined.initiative).toBe(review.id);
    const loose = store.createCard({ project_id: project.id, by: AGENT, title: "Hover", initiative_name: "codereview" }).card;
    expect(loose.initiative).toBe(review.id);
    expect(store.initiatives().length).toBe(1);

    const billing = store.createCard({ project_id: project.id, by: AGENT, title: "Invoices", initiative_name: "Billing" }).card;
    const made = store.initiatives().find((i) => i.name === "Billing")!;
    expect(made.created_by).toEqual(AGENT);
    expect(billing.initiative).toBe(made.id);
    // The agent's say moves it, and its history names the agent.
    store.updateCard(joined.id, { by: AGENT, initiative_name: "billing" });
    expect(store.card(joined.id)!.initiative).toBe(made.id);
    store.updateCard(joined.id, { by: AGENT, initiative_name: "" });
    expect(store.cardWire(store.card(joined.id)!).initiative).toBeNull();
    const lines = store.cardHistory(joined.id).filter((entry) => entry.kind === "initiative");
    expect(lines.map((entry) => [entry.kind === "initiative" ? entry.initiative : "?", entry.by.kind])).toEqual([
      [null, "agent"],
      [made.id, "agent"],
    ]);
    // A say without the field keeps the initiative.
    store.updateCard(billing.id, { by: AGENT, say: "drafted" });
    expect(store.card(billing.id)!.initiative).toBe(made.id);
  });

  test("a refused card or a replay makes no initiative; the name rules hold for agents", () => {
    const { store, project } = world();
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "", initiative_name: "Ghost" }))).toBe("validation_error");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", column: "in_review", initiative_name: "Ghost" }))).toBe("validation_error");
    expect(store.initiatives()).toEqual([]);
    store.createCard({ project_id: project.id, by: AGENT, title: "Once", idempotency_key: "k" });
    store.createCard({ project_id: project.id, by: AGENT, title: "Once", idempotency_key: "k", initiative_name: "Ghost" });
    expect(store.initiatives()).toEqual([]);

    // A refused note (the last check) leaves no initiative either, on create and on a later write.
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", notes: "n".repeat(4001), initiative_name: "Ghost" }))).toBe("validation_error");
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Kept" });
    expect(refusal(() => store.updateCard(card.id, { by: AGENT, notes: "n".repeat(4001), initiative_name: "Ghost" }))).toBe("validation_error");
    expect(store.initiatives()).toEqual([]);

    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", initiative_name: "x".repeat(41) }))).toBe("validation_error");
  });

  test("no cap: the person and agents make as many as they like", () => {
    const { store, project } = world();
    for (let i = 0; i < 60; i++) store.createInitiative({ name: `Effort ${i}`, by: PERSON });
    const agents = store.createCard({ project_id: project.id, by: AGENT, title: "x", initiative_name: "One more" }).card;
    expect(store.initiative(agents.initiative!)!.name).toBe("One more");
    expect(store.initiatives().filter((i) => i.deleted_at === null).length).toBe(61);
    expect(store.createInitiative({ name: "And another", by: PERSON }).name).toBe("And another");
  });

  test("the field takes a live one's id as well as its name; a stale id is ignored, and names nothing", () => {
    const { store, project } = world();
    const shape = store.createInitiative({ name: "Shape", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Tokens", initiative_name: shape.id });
    expect(card.initiative).toBe(shape.id);
    const other = store.createCard({ project_id: project.id, by: AGENT, title: "Hover" }).card;
    store.updateCard(other.id, { by: AGENT, initiative_name: ` ${shape.id} ` });
    expect(store.card(other.id)!.initiative).toBe(shape.id);
    expect(store.initiatives().length).toBe(1);

    // Stale (deleted, or never known): no error, no initiative named after the id, the card's own unchanged.
    const memory = store.createInitiative({ name: "Memory", by: PERSON });
    const inMemory = store.createCard({ project_id: project.id, by: AGENT, title: "Cache", initiative_name: "Memory" }).card;
    store.deleteInitiative(shape.id);
    const before = store.initiatives().length;
    const stale = store.createCard({ project_id: project.id, by: AGENT, title: "Late", initiative_name: shape.id }).card;
    expect(stale.initiative).toBeNull();
    store.updateCard(inMemory.id, { by: AGENT, initiative_name: shape.id });
    expect(store.card(inMemory.id)!.initiative).toBe(memory.id);
    store.updateCard(inMemory.id, { by: AGENT, say: "still on it", initiative_name: "ini_01JX0000000000000000000000" });
    expect(store.card(inMemory.id)!).toMatchObject({ initiative: memory.id, said: "still on it" });
    expect(store.initiatives().length).toBe(before);
  });

  test("deleted, an initiative's cards stay and read as in none; the person's Undo puts them back", () => {
    const { store, project, dir } = world();
    const shape = store.createInitiative({ name: "Shape", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Tokens", initiative_name: "Shape" });
    const lines = store.cursor();
    store.deleteInitiative(shape.id);
    expect(store.cursor()).toBe(lines + 1);
    expect(store.card(card.id)).not.toBeNull();
    expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();

    expect(store.restoreInitiative(shape.id).deleted_at).toBeNull();
    expect(store.cardWire(store.card(card.id)!).initiative).toBe(shape.id);
    const again = InboxStore.open(dir);
    expect(again.initiative(shape.id)!.deleted_at).toBeNull();
    expect(again.cardWire(again.card(card.id)!).initiative).toBe(shape.id);
    // A live one answers as it is; a name taken since refuses.
    const cursor = store.cursor();
    store.restoreInitiative(shape.id);
    expect(store.cursor()).toBe(cursor);
    store.deleteInitiative(shape.id);
    store.createInitiative({ name: "shape", by: PERSON });
    expect(refusal(() => store.restoreInitiative(shape.id))).toBe("initiative_exists");
    expect(refusal(() => store.restoreInitiative("ini_01JX0000000000000000000000"))).toBe("initiative_not_found");
  });

  test("an agent still cannot make one directly or set one through the person's doors", () => {
    const { store, project } = world();
    const shape = store.createInitiative({ name: "Shape", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Tokens", initiative_name: "shape" });
    expect(refusal(() => store.createInitiative({ name: "Mine", by: AGENT }))).toBe("initiative_person_only");
    expect(refusal(() => store.setCardInitiative(card.id, null, AGENT))).toBe("initiative_person_only");
    expect(refusal(() => store.createCard({ project_id: project.id, by: AGENT, title: "x", initiative: shape.id }))).toBe("initiative_person_only");
    // A name in other case joins the initiative; it never renames it.
    expect(store.initiative(shape.id)!.name).toBe("Shape");
  });

  // The clean room's failure: "C#" went silently into "C++". A name joins across case, spaces, `-`, `_` and a leading `#` and nothing else.
  test("a name joins across case, spaces, -, _ and a leading #, and across nothing else", () => {
    const { store, project } = world();
    const review = store.createInitiative({ name: "Code review", by: PERSON });
    for (const name of ["Code-Review", "Code Review", "#CodeReview", "code_review", "# code review", "CODEREVIEW"]) {
      expect([name, store.createCard({ project_id: project.id, by: AGENT, title: name, initiative_name: name }).card.initiative]).toEqual([name, review.id]);
    }
    expect(store.initiatives().length).toBe(1);

    for (const [live, wanted] of [["C++", "C#"], ["C++", "c"], ["QA", "Q&A"], ["v1.2", "v12"], ["AB", "A/B"], ["RD", "R&D"], [".NET", "NET"], ["Code review", "\uFF23ode review"]] as const) {
      if (!store.initiatives().some((i) => i.name === live)) store.createInitiative({ name: live, by: PERSON });
      const ini = store.initiatives().find((i) => i.name === live)!;
      const { card } = store.createCard({ project_id: project.id, by: AGENT, title: wanted, initiative_name: wanted });
      expect([wanted, card.initiative === ini.id]).toEqual([wanted, false]);
      expect([wanted, store.initiative(card.initiative!)!.name]).toEqual([wanted, wanted]);
    }

    // Only those marks: an empty key, so the exact name or nothing.
    const dashes = store.createInitiative({ name: "---", by: PERSON });
    expect(store.initiativeNamed("---")!.id).toBe(dashes.id);
    expect(store.initiativeNamed("___")).toBeNull();
  });

  test("two live names with one key: the exact one, else the first made, whatever the clock or a reload says", () => {
    const { dir } = world();
    // The second is stamped earlier: an order by time (or by id on a tie) would pick it, and a tag reads the first made.
    let at = "2026-11-05T12:00:00.000Z";
    const store = InboxStore.open(dir, { now: () => new Date(at) });
    const first = store.createInitiative({ name: "Code review", by: PERSON });
    at = "2026-11-05T11:00:00.000Z";
    const second = store.createInitiative({ name: "CodeReview", by: PERSON });
    expect(store.initiatives().map((i) => i.id)).toEqual([second.id, first.id]);
    for (const read of [store, InboxStore.open(dir)]) {
      expect(read.initiativeNamed("codereview")!.id).toBe(second.id);
      expect(read.initiativeNamed("Code review")!.id).toBe(first.id);
      expect(read.initiativeNamed("code-review")!.id).toBe(first.id);
      expect(read.initiativeToDelete("code  re view")!.id).toBe(first.id);
    }
  });

  test("two quote characters mean none, as \"\" does; a value shaped like an id is not found, and never a name", () => {
    const { store, project } = world();
    const billing = store.createInitiative({ name: "Billing", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Out", initiative_name: "Billing" });
    for (const out of ['""', "''", ' "" ']) {
      store.updateCard(card.id, { by: AGENT, initiative_name: "Billing" });
      store.updateCard(card.id, { by: AGENT, initiative_name: out });
      expect([out, store.cardWire(store.card(card.id)!).initiative]).toEqual([out, null]);
      expect([out, store.createCard({ project_id: project.id, by: AGENT, title: out, initiative_name: out }).card.initiative]).toEqual([out, null]);
    }
    expect(store.initiatives().map((i) => i.name)).toEqual(["Billing"]);

    const cards = store.listCards().length;
    for (const shaped of ["ini_abc", billing.id.slice(0, 12), billing.id.toUpperCase(), "#ini_abc", "ini_"]) {
      expect(() => store.createCard({ project_id: project.id, by: AGENT, title: "Shaped", initiative_name: shaped })).toThrow(expect.objectContaining({ code: "initiative_not_found" }));
      expect(() => store.updateCard(card.id, { by: AGENT, initiative_name: shaped })).toThrow(expect.objectContaining({ code: "initiative_not_found" }));
    }
    expect(store.listCards().length).toBe(cards);
    expect(store.initiatives().map((i) => i.name)).toEqual(["Billing"]);
    // A name that only starts that way is a name.
    const spaced = store.createCard({ project_id: project.id, by: AGENT, title: "Spaced", initiative_name: "ini_ rollout" }).card;
    expect(store.initiative(spaced.initiative!)!.name).toBe("ini_ rollout");
  });

  // "#Billing" is how the Inbox writes a tag, so an agent may well pass it: the name must not carry the mark.
  test("a new name loses its leading #; # alone makes nothing; a # inside the name stays", () => {
    const { store, project } = world();
    const made = (initiative_name: string) => {
      const { card } = store.createCard({ project_id: project.id, by: AGENT, title: initiative_name, initiative_name });
      return store.initiative(card.initiative!)!.name;
    };
    expect(made("#Billing")).toBe("Billing");
    expect(made("  ## Auth flow ")).toBe("Auth flow");
    expect(made("C#")).toBe("C#");
    // The limit reads the name without the mark.
    expect(made(`#${"x".repeat(40)}`)).toBe("x".repeat(40));

    const before = store.initiatives().length;
    const cards = store.listCards().length;
    for (const initiative_name of ["#", " ## ", "# "]) {
      expect(() => store.createCard({ project_id: project.id, by: AGENT, title: "Empty", initiative_name })).toThrow();
    }
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Kept", initiative_name: "Billing" });
    expect(() => store.updateCard(card.id, { by: AGENT, initiative_name: "#" })).toThrow();
    expect(store.cardWire(store.card(card.id)!).initiative).toBe(card.initiative);
    expect(store.initiatives().length).toBe(before);
    expect(store.listCards().length).toBe(cards + 1);

    // With the mark it still names a live one: joined, no second "!!!".
    const marks = store.createInitiative({ name: "!!!", by: PERSON });
    expect(store.createCard({ project_id: project.id, by: AGENT, title: "Marks", initiative_name: "#!!!" }).card.initiative).toBe(marks.id);
    expect(store.initiatives().filter((i) => i.name === "!!!").length).toBe(1);
  });

  test("the name to delete matches ignoring case, spaces and a leading # only; the id too", () => {
    const { store } = world();
    const plus = store.createInitiative({ name: "C++", by: PERSON });
    const review = store.createInitiative({ name: "Code review", by: PERSON });
    const billing = store.createInitiative({ name: "Billing", by: PERSON });
    for (const miss of ["C#", "c", "Code-Review", "code_review", "\uFF23ode review", "#", "##"]) {
      expect([miss, store.initiativeToDelete(miss)]).toEqual([miss, null]);
    }
    expect(store.initiativeToDelete("  c++ ")!.id).toBe(plus.id);
    expect(store.initiativeToDelete("CODE  REVIEW")!.id).toBe(review.id);
    expect(store.initiativeToDelete("codereview")!.id).toBe(review.id);
    expect(store.initiativeToDelete("#CodeReview")!.id).toBe(review.id);
    expect(store.initiativeToDelete("#Billing")!.id).toBe(billing.id);
    expect(store.initiativeToDelete("# billing")!.id).toBe(billing.id);
    expect(store.initiativeToDelete(plus.id)!.id).toBe(plus.id);
    // An initiative the person named with the mark: its exact name, and "##" is not it.
    const mark = store.createInitiative({ name: "#", by: PERSON });
    expect(store.initiativeToDelete("##")).toBeNull();
    expect(store.initiativeToDelete("#")!.id).toBe(mark.id);
    store.deleteInitiative(plus.id);
    expect(store.initiativeToDelete(plus.id)).toBeNull();
    expect(store.initiativeToDelete("C++")).toBeNull();
  });

  test("the last change wins, the person's or an agent's", () => {
    const { store, project } = world();
    const shape = store.createInitiative({ name: "Shape", by: PERSON });
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Tokens" });
    store.setCardInitiative(card.id, shape.id, PERSON);
    store.updateCard(card.id, { by: AGENT, initiative_name: "Billing" });
    const billing = store.initiatives().find((i) => i.name === "Billing")!;
    expect(store.card(card.id)!.initiative).toBe(billing.id);
    store.setCardInitiative(card.id, shape.id, PERSON);
    expect(store.card(card.id)!.initiative).toBe(shape.id);
  });
});
