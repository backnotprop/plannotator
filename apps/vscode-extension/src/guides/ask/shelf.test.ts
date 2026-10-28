import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answersPath, newAnswerId, type AnswerRecord } from "./answers";
import { AnswerShelf } from "./shelf";

let dir = "";
let before: string | undefined;
beforeEach(() => {
  before = process.env.PLANNOTATOR_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "pn-shelf-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
});
afterEach(() => {
  if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});

const GUIDE = "1761200000000-retry";
const record = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  v: 1, id: newAnswerId(), guideId: GUIDE, repoKey: "k", question: "Why?", about: { kind: "chapter", chapter: 0, chapterTitle: "x" },
  askedAt: Date.now(), status: "answering", agent: { id: "claude-code", label: "Claude Code" }, ...over,
});

describe("the answer shelf", () => {
  it("never writes back an answer whose guide was deleted, on disk or in memory", () => {
    for (const persists of [true, false]) {
      const shelf = new AnswerShelf();
      const r = record();
      expect(shelf.save(r, persists)).toBe(true);
      shelf.removeGuide("k", GUIDE);
      expect(existsSync(answersPath("k", GUIDE))).toBe(false);
      expect(shelf.save({ ...r, status: "answered", html: "<p>late</p>" }, persists)).toBe(false);
      expect(existsSync(answersPath("k", GUIDE))).toBe(false);
      expect(shelf.list("k", GUIDE, persists)).toEqual([]);
    }
  });

  it("never writes back a deleted answer; the others stay", () => {
    const shelf = new AnswerShelf();
    const a = record({ askedAt: 1 });
    const b = record({ askedAt: 2 });
    shelf.save(a, true);
    shelf.save(b, true);
    shelf.remove(a, true);
    expect(shelf.save({ ...a, status: "answered" }, true)).toBe(false);
    expect(shelf.list("k", GUIDE, true).map((r) => r.id)).toEqual([b.id]);
  });

  it("holds one question slot per guide until released", () => {
    const shelf = new AnswerShelf();
    expect(shelf.reserve(GUIDE)).toBe(true);
    expect(shelf.reserve(GUIDE)).toBe(false);
    expect(shelf.reserve("other")).toBe(true);
    shelf.release(GUIDE);
    expect(shelf.reserve(GUIDE)).toBe(true);
  });
});
