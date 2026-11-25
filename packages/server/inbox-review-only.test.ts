/**
 * The Inbox for code review only (inbox-review-only.ts) over a stand-in config.json, with the real notes in a scratch
 * agent home (tests/helpers/fake-agents.ts; the real home is never touched). No Inbox runs.
 *
 * What regresses: switching to code review only leaving the Inbox note in an agent's instructions file, or touching
 * the person's own text around it; switching back not putting it back, or writing it in a section the person edited;
 * a new code-review-only person getting a note by itself; switching to code review only without Code review on (the
 * mode would do nothing); switching back asking for anything (a gate, Code review turned off); the Settings row's
 * switch reading the setting without Code review; the welcome shown twice, or to the full Inbox.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { addInboxNote, INBOX_NOTE_BLOCK, noteStatus, noteTarget } from "./inbox-agent-notes";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { createReviewOnly } from "./inbox-review-only";
import { hideInboxNotesForReviewOnly, restoreInboxNotesAfterReviewOnly } from "./inbox-review-only-notes";

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;

beforeEach(() => {
  fake = createFakeAgents("plannotator-review-only-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
});
afterEach(() => fake.remove());

const MINE_BEFORE = "# My Gemini rules\n\nAlways run the tests.\n";
const MINE_AFTER = "\n## Later\n\nKeep commits small.\n";

/** Gemini and Qwen Code on this computer, each with the person's own rules file. */
function agents() {
  mkdirSync(join(fake.home, ".gemini"), { recursive: true });
  mkdirSync(join(fake.home, ".qwen"), { recursive: true });
  const gemini = noteTarget("gemini", e).path!;
  const qwen = noteTarget("qwen", e).path!;
  for (const path of [gemini, qwen]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, MINE_BEFORE);
  }
  return { gemini, qwen };
}

/** One computer: config.json in memory, the real notes in the scratch home. */
function inbox(start: PlannotatorConfig = {}) {
  let config: PlannotatorConfig = structuredClone(start);
  const said = { changed: 0, auto: 0, codeReviewOn: 0 };
  const save = (patch: Partial<PlannotatorConfig>) => {
    config = { ...config, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete (config as Record<string, unknown>)[key];
  };
  const codeReviewOn = () => config.inboxCodeReview === true;
  const reviewOnly = createReviewOnly({
    load: () => structuredClone(config),
    save,
    codeReviewOn,
    turnOnCodeReview: () => {
      said.codeReviewOn++;
      save({ inboxCodeReview: true });
    },
    notes: {
      hide: () => hideInboxNotesForReviewOnly(dataDir, e),
      restore: (ids) => restoreInboxNotesAfterReviewOnly(ids, dataDir, e),
      auto: async () => void said.auto++,
    },
    changed: () => void said.changed++,
    now: () => new Date("2026-11-25T10:00:00.000Z"),
  });
  return { reviewOnly, said, config: () => config, set: save };
}

const read = (path: string) => readFileSync(path, "utf8");

describe("the notes", () => {
  test("to code review only: out of every file, only their own section; back to the full Inbox: put back the same way", async () => {
    const { gemini, qwen } = agents();
    for (const id of ["gemini", "qwen"] as const) expect(addInboxNote(id, dataDir, e)).toMatchObject({ ok: true });
    // The person writes more after the note.
    writeFileSync(gemini, read(gemini) + MINE_AFTER);
    const withNote = read(gemini);
    expect(withNote).toContain(INBOX_NOTE_BLOCK);

    const one = inbox({ inboxCodeReview: true });
    expect(await one.reviewOnly.save({ on: false })).toEqual({ on: false, chosen: true });
    expect(one.config().inboxReviewOnly).toBe(true);
    expect(read(gemini)).not.toContain("plannotator-inbox");
    expect(read(gemini)).toBe(`${MINE_BEFORE}${MINE_AFTER}`);
    expect(read(qwen)).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes?.sort()).toEqual(["gemini", "qwen"]);
    expect(one.said.auto).toBe(0);

    // Back to the full Inbox: no gate, nothing asked; Code review stays on.
    expect(await one.reviewOnly.save({ on: true })).toEqual({ on: true, chosen: true });
    expect(one.config().inboxReviewOnly).toBe(false);
    expect(one.config().inboxCodeReview).toBe(true);
    expect(one.config().inboxReviewOnlyNotes).toBeUndefined();
    expect(read(gemini)).toContain(INBOX_NOTE_BLOCK);
    expect(read(gemini).startsWith(MINE_BEFORE)).toBe(true);
    expect(read(gemini)).toContain(MINE_AFTER);
    expect(read(qwen)).toContain(INBOX_NOTE_BLOCK);
    expect(read(qwen).startsWith(MINE_BEFORE)).toBe(true);
    // Then what a full Inbox writes by itself.
    expect(one.said.auto).toBe(1);
    expect(one.said.changed).toBe(2);
  });

  test("a note section the person edited is theirs: left in while code review only, and never written twice after", async () => {
    const { gemini } = agents();
    expect(addInboxNote("gemini", dataDir, e)).toMatchObject({ ok: true });
    writeFileSync(gemini, read(gemini).replace("## Plannotator Inbox", "## Plannotator Inbox (mine now)"));
    expect(noteStatus("gemini", dataDir, e).state).toBe("edited");
    const edited = read(gemini);
    const one = inbox({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    expect(read(gemini)).toBe(edited);
    await one.reviewOnly.save({ on: true });
    expect(read(gemini)).toBe(edited);
  });

  test("a new code-review-only person: no note is written, and what the full Inbox writes by itself is not asked for", async () => {
    const { gemini } = agents();
    const one = inbox({ inboxCodeReview: true, inboxReviewOnly: true });
    await one.reviewOnly.syncNotes();
    await one.reviewOnly.syncNotes();
    expect(read(gemini)).toBe(MINE_BEFORE);
    expect(one.config().inboxReviewOnlyNotes).toEqual([]);
    expect(one.said.auto).toBe(0);
  });

  test("Code review turned off: the full Inbox again, so the notes come back at the next pass", async () => {
    const { gemini } = agents();
    addInboxNote("gemini", dataDir, e);
    const one = inbox({ inboxCodeReview: true });
    await one.reviewOnly.save({ on: false });
    expect(read(gemini)).toBe(MINE_BEFORE);
    one.set({ inboxCodeReview: false });
    expect(one.reviewOnly.on()).toBe(false);
    await one.reviewOnly.syncNotes();
    expect(read(gemini)).toContain(INBOX_NOTE_BLOCK);
  });
});

describe("the switch", () => {
  test("to code review only with Code review off turns Code review on first, as its own row does", async () => {
    const one = inbox();
    await one.reviewOnly.save({ on: false });
    expect(one.said.codeReviewOn).toBe(1);
    expect(one.config()).toMatchObject({ inboxCodeReview: true, inboxReviewOnly: true });
    expect(one.reviewOnly.on()).toBe(true);
  });

  test("on the wire: the full Inbox until chosen; `chosen` once either was; the setting without Code review is the full Inbox", () => {
    expect(inbox().reviewOnly.wire()).toEqual({ full_inbox: { on: true } });
    expect(inbox({ inboxCodeReview: true, inboxReviewOnly: true }).reviewOnly.wire()).toEqual({ full_inbox: { on: false, chosen: true } });
    expect(inbox({ inboxCodeReview: true, inboxReviewOnly: false }).reviewOnly.wire()).toEqual({ full_inbox: { on: true, chosen: true } });
    const off = inbox({ inboxCodeReview: false, inboxReviewOnly: true });
    expect(off.reviewOnly.wire()).toEqual({ full_inbox: { on: true, chosen: true } });
    // What a linked computer is given is the setting itself.
    expect(off.reviewOnly.saved()).toBe(true);
  });

  test("a bad body is refused and changes nothing", async () => {
    const one = inbox({ inboxCodeReview: true });
    for (const bad of [null, true, { on: "no" }, { on: false, extra: 1 }, []]) await expect(one.reviewOnly.save(bad)).rejects.toThrow("full_inbox");
    expect(one.config().inboxReviewOnly).toBeUndefined();
  });
});

describe("the welcome", () => {
  test("due once, to code review only; claimed, never again", () => {
    const due = { inboxCodeReview: true, inboxReviewOnly: true, inboxReviewWelcome: { dueAt: "2026-11-25T09:00:00.000Z" } };
    const one = inbox(due);
    expect(one.reviewOnly.welcomeWire()).toEqual({ review_welcome: true });
    one.reviewOnly.welcomeSeen(true);
    expect(one.config().inboxReviewWelcome).toEqual({ dueAt: "2026-11-25T09:00:00.000Z", shownAt: "2026-11-25T10:00:00.000Z" });
    expect(one.reviewOnly.welcomeWire()).toEqual({});
    // Never asked for: never due. The full Inbox: never shown.
    expect(inbox({ inboxCodeReview: true, inboxReviewOnly: true }).reviewOnly.welcomeWire()).toEqual({});
    expect(inbox({ ...due, inboxReviewOnly: false }).reviewOnly.welcomeWire()).toEqual({});
    expect(() => one.reviewOnly.welcomeSeen("yes")).toThrow("review_welcome");
  });
});
