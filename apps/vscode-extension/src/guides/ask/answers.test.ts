import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAnswer, listAnswers, loadAnswer, newAnswerId, saveAnswer, staleNote, answersPath, type AnswerRecord } from "./answers";
import { deleteSavedGuide } from "../store";

let dir = "";
let before: string | undefined;

beforeEach(() => {
  before = process.env.PLANNOTATOR_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "pn-answers-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
});

afterEach(() => {
  if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = before;
  rmSync(dir, { recursive: true, force: true });
});

const GUIDE = "1761200000000-retry-failed-webhook-deliveries";

function record(over: Partial<AnswerRecord> = {}): AnswerRecord {
  return {
    v: 1,
    id: newAnswerId(),
    guideId: GUIDE,
    repoKey: "github.com__northwind__checkout-service",
    question: "Why did this change?",
    about: { kind: "selection", chapter: 1, chapterTitle: "Delivery loop learns to back off", path: "src/webhooks/deliver.ts", side: "head", lines: { start: 25, end: 31 }, code: "const attempt = job.attempt + 1;", fileHash: "aaa" },
    askedAt: Date.now(),
    status: "answered",
    title: "Failures used to loop back.",
    html: "<p>Now each one gets a decision.</p><script>1</script>",
    agent: { id: "claude-code", label: "Claude Code", model: { id: "sonnet", label: "Sonnet" } },
    headSha: "9b07e4d0000",
    ...over,
  };
}

describe("answers saved with the guide", () => {
  it("saves, lists newest first and loads under vscode/answers/<guide>/", () => {
    const a = record({ askedAt: 1000 });
    const b = record({ askedAt: 2000, question: "What could break?" });
    saveAnswer(a);
    saveAnswer(b);
    expect(answersPath(a.repoKey, GUIDE)).toBe(join(dir, "guides", a.repoKey, "vscode", "answers", GUIDE));
    expect(listAnswers(a.repoKey, GUIDE).map((r) => r.question)).toEqual(["What could break?", "Why did this change?"]);
    expect(loadAnswer(a.repoKey, GUIDE, a.id)?.html).toContain("<script>");
    deleteAnswer(a.repoKey, GUIDE, a.id);
    expect(listAnswers(a.repoKey, GUIDE).map((r) => r.id)).toEqual([b.id]);
  });

  it("reads an answer left answering (VS Code closed) as stopped, and ignores files that are not answers", () => {
    const a = record({ status: "answering" });
    saveAnswer(a);
    writeFileSync(join(answersPath(a.repoKey, GUIDE), "junk.json"), "{}");
    const [loaded] = listAnswers(a.repoKey, GUIDE);
    expect(loaded.status).toBe("stopped");
    expect(loaded.statusMessage).toContain("VS Code closed");
    expect(listAnswers(a.repoKey, GUIDE)).toHaveLength(1);
  });

  it("refuses ids that could leave the folder", () => {
    expect(() => saveAnswer(record({ id: "../../x" }))).toThrow();
    expect(loadAnswer("k", GUIDE, "../x")).toBeNull();
    expect(listAnswers("k", "../..")).toEqual([]);
  });

  it("goes when the guide is deleted", () => {
    const a = record();
    saveAnswer(a);
    expect(existsSync(answersPath(a.repoKey, GUIDE))).toBe(true);
    deleteSavedGuide(a.repoKey, GUIDE);
    expect(existsSync(answersPath(a.repoKey, GUIDE))).toBe(false);
  });

  it("says when the file or the change moved since the answer", () => {
    const a = record();
    expect(staleNote(a, { fileHash: "aaa" })).toBeNull();
    expect(staleNote(a, { fileHash: "bbb" })).toBe("Written for 9b07e4d; the file has changed since.");
    const chapter = record({ about: { kind: "chapter", chapter: 1, chapterTitle: "x" } });
    expect(staleNote(chapter, { headSha: "9b07e4d0000" })).toBeNull();
    expect(staleNote(chapter, { headSha: "1111111" })).toBe("Written for 9b07e4d; the change has moved since.");
  });
});
