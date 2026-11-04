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
