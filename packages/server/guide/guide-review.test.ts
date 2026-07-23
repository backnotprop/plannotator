import { afterEach, describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeGuideMarkerPrompt,
  createGuideSession,
  repairGuideJsonText,
  validateGuideOutput,
  parseGuideStreamOutput,
} from "./guide-review";
import { markerClose, markerOpen } from "../marker-review";
import { createGuideStore, type GuidePersistenceContext } from "./guide-storage";

// Pins the behaviors the PR-993 review rounds fixed. This module previously
// had NO direct coverage — the repair ladder and validation are pure logic
// exercised only end-to-end through live agent runs, which is exactly where
// regressions hide.

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const PI_FIXTURE_NONCE = "pn0123456789ab";
const tempDirs: string[] = [];

function tempGuideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-guide-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const piInsufficientCreditsStdout = readFileSync(
  new URL("../fixtures/pi-insufficient-credits.ndjson", import.meta.url),
  "utf8",
);

function guideJson(sections: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ title: "T", intent: "I", sections, unplacedFiles: [], ...extra });
}

describe("validateGuideOutput", () => {
  it("gives a diffs-only section a fallback title instead of a blank chapter (round 12)", () => {
    const raw = JSON.parse(guideJson([{ title: "", overview: "", diffs: [{ file: "src/a.ts" }] }]));
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].title).toBe("Untitled section");
    expect(result.guide.sections[0].diffs).toEqual([{ file: "src/a.ts" }]);
  });

  it("first placement wins on duplicate refs; loser section keeps its other files", () => {
    const raw = JSON.parse(
      guideJson([
        { title: "One", overview: "o", diffs: [{ file: "src/a.ts" }] },
        { title: "Two", overview: "o", diffs: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].diffs).toEqual([{ file: "src/a.ts" }]);
    expect(result.guide.sections[1].diffs).toEqual([{ file: "src/b.ts" }]);
  });

  it("drops refs outside changedFiles and fails closed when nothing survives", () => {
    const raw = JSON.parse(guideJson([{ title: "X", overview: "", diffs: [{ file: "not/changed.ts" }] }]));
    const result = validateGuideOutput(raw, FILES);
    expect("error" in result).toBe(true);
  });

  it("keeps a deliberate prose-only section but drops one that LOST its diffs to validation", () => {
    const raw = JSON.parse(
      guideJson([
        { title: "Context", overview: "Background reading.", diffs: [] },
        { title: "Ghost", overview: "Had only invalid refs.", diffs: [{ file: "not/changed.ts" }] },
        { title: "Real", overview: "o", diffs: [{ file: "src/a.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections.map((s) => s.title)).toEqual(["Context", "Real"]);
  });

  it("unplacedFiles = unplaced changed files, deduped against placements, ignoring fabricated entries", () => {
    const raw = JSON.parse(
      guideJson([{ title: "S", overview: "o", diffs: [{ file: "src/a.ts" }] }], {
        // a.ts is placed (must not double-render); fake.ts is not a changed file.
        unplacedFiles: ["src/a.ts", "fake.ts", "src/b.ts"],
      }),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.unplacedFiles?.sort()).toEqual(["src/b.ts", "src/c.ts"]);
  });

  it("carries per-file summaries through, omitting blank/non-string ones without dropping the ref", () => {
    const raw = JSON.parse(
      guideJson([
        {
          title: "S",
          overview: "o",
          diffs: [
            { file: "src/a.ts", summary: "Adds the thing." },
            { file: "src/b.ts", summary: "   " },
            { file: "src/c.ts", summary: 42 },
          ],
        },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.sections[0].diffs).toEqual([
      { file: "src/a.ts", summary: "Adds the thing." },
      { file: "src/b.ts" },
      { file: "src/c.ts" },
    ]);
  });

  it("coerces non-string title/intent from prompt-only marker engines", () => {
    const raw = JSON.parse(guideJson([{ title: "S", overview: "o", diffs: [{ file: "src/a.ts" }] }]));
    raw.title = 42;
    raw.intent = { nested: true };
    const result = validateGuideOutput(raw, FILES);
    if ("error" in result) throw new Error(result.error);
    expect(result.guide.title).toBe("Guided review");
    expect(result.guide.intent).toBe("");
  });
});

describe("repairGuideJsonText", () => {
  it("passes valid JSON through", () => {
    const out = repairGuideJsonText(guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]));
    expect(out?.sections?.length).toBe(1);
  });

  it("strips trailing commas outside strings (but not inside them)", () => {
    const text = `{"title":"a, b,","intent":"","sections":[{"title":"S","overview":"o","diffs":[{"file":"f"},]},],"unplacedFiles":[]}`;
    const out = repairGuideJsonText(text);
    expect(out?.sections?.length).toBe(1);
    expect((out as { title?: string })?.title).toBe("a, b,");
  });

  it("closes unbalanced brackets from truncated output, including a dangling string", () => {
    const truncated = `{"title":"T","intent":"","sections":[{"title":"S","overview":"cut off mid-sent`;
    const out = repairGuideJsonText(truncated);
    expect(out).not.toBeNull();
    expect(Array.isArray(out?.sections)).toBe(true);
  });

  it("returns null for hopeless input (fail-closed, recovery flow takes over)", () => {
    expect(repairGuideJsonText("not json at all")).toBeNull();
    expect(repairGuideJsonText("")).toBeNull();
  });
});

describe("parseGuideStreamOutput", () => {
  it("extracts structured_output from the last claude stream-json result event", () => {
    const guide = JSON.parse(guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]));
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", structured_output: guide }),
    ].join("\n");
    const out = parseGuideStreamOutput(stream);
    expect(out?.sections?.length).toBe(1);
  });

  it("repairs a truncated final result line via the embedded structured_output value", () => {
    const guide = guideJson([{ title: "S", overview: "o", diffs: [{ file: "f" }] }]);
    // Simulate the NDJSON result event cut off mid-stream: valid prefix,
    // then the structured_output value truncated before its closing braces.
    const truncatedLine = `{"type":"result","structured_output":${guide.slice(0, guide.length - 20)}`;
    const out = parseGuideStreamOutput(truncatedLine);
    expect(out).not.toBeNull();
    expect(Array.isArray(out?.sections)).toBe(true);
  });

  it("returns null on empty stdout", () => {
    expect(parseGuideStreamOutput("")).toBeNull();
  });
});

describe("createGuideSession persistence", () => {
  const context: GuidePersistenceContext = {
    targets: [{ kind: "branch", repository: "github.com/acme/widgets", branch: "feature/persist" }],
    revision: "abc123",
    fingerprint: "patch-one",
  };

  it("restores successful guide output, launch settings, and Reviewed state in a new session", async () => {
    const dir = tempGuideDir();
    const first = createGuideSession(createGuideStore(dir));
    first.registerPersistence("job-1", context);
    const output = JSON.parse(guideJson([
      { title: "Persisted", overview: "Stored", diffs: [{ file: "src/a.ts" }] },
    ]));
    await first.onJobComplete({
      job: { id: "job-1", engine: "claude", model: "sonnet", effort: "low" },
      meta: { stdout: JSON.stringify({ type: "result", structured_output: output }) },
      changedFiles: FILES,
    });
    first.saveReviewed("job-1", [true]);

    const restarted = createGuideSession(createGuideStore(dir));
    expect(restarted.getCurrentGuide(context)).toMatchObject({
      id: "job-1",
      outdated: false,
      engine: "claude",
      launch: { engine: "claude", model: "sonnet", effort: "low" },
    });
    expect(restarted.getGuide("job-1")?.reviewed).toEqual([true]);
    expect(restarted.getGuide("job-1")?.sections[0].title).toBe("Persisted");
  });

  it("keeps the previous persisted guide when regeneration fails", async () => {
    const dir = tempGuideDir();
    const store = createGuideStore(dir);
    const first = createGuideSession(store);
    first.registerPersistence("old-job", context);
    first.submitManualOutput("old-job", guideJson([
      { title: "Still available", overview: "Stored", diffs: [{ file: "src/a.ts" }] },
    ]), FILES);

    first.registerPersistence("failed-job", { ...context, revision: "def456", fingerprint: "patch-two" });
    await first.onJobComplete({
      job: { id: "failed-job", engine: "pi", prompt: composeGuideMarkerPrompt("Review", PI_FIXTURE_NONCE) },
      meta: { stdout: "not valid guide output" },
      changedFiles: FILES,
    });

    const restarted = createGuideSession(createGuideStore(dir));
    expect(restarted.getCurrentGuide({ ...context, revision: "def456", fingerprint: "patch-two" }))
      .toMatchObject({ id: "old-job", outdated: true });
    expect(restarted.getGuide("old-job")?.sections[0].title).toBe("Still available");
  });
});

describe("createGuideSession marker completion", () => {
  it("surfaces a Pi provider failure instead of classifying exit-0 NDJSON as malformed guide output", async () => {
    const session = createGuideSession();
    const result = await session.onJobComplete({
      job: {
        id: "pi-insufficient-credits",
        engine: "pi",
        prompt: composeGuideMarkerPrompt("Review the changed files.", PI_FIXTURE_NONCE),
      },
      meta: { stdout: piInsufficientCreditsStdout },
      changedFiles: FILES,
    });

    expect(result).toEqual({ summary: null, error: "Insufficient API credits" });
    expect(session.failedPayloads.has("pi-insufficient-credits")).toBe(false);
  });

  it("keeps ordinary malformed Pi output on the strict parse and repair path", async () => {
    const jobId = "pi-malformed-guide";
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I could not format the guide." }],
        stopReason: "stop",
      },
    });
    const session = createGuideSession();

    const result = await session.onJobComplete({
      job: {
        id: jobId,
        engine: "pi",
        prompt: composeGuideMarkerPrompt("Review the changed files.", PI_FIXTURE_NONCE),
      },
      meta: { stdout },
      changedFiles: FILES,
    });

    expect(result).toEqual({ summary: null });
    expect(session.failedPayloads.has(jobId)).toBe(true);
    expect(session.getGuide(jobId)).toBeNull();
  });

  it("preserves a valid marker guide after an earlier transient Pi error event", async () => {
    const jobId = "pi-recovered-guide";
    const validGuide = guideJson([
      {
        title: "Recovered",
        overview: "The retry completed.",
        diffs: [{ file: "src/a.ts", summary: "Updates A." }],
      },
    ]);
    const transientErrorPrefix = piInsufficientCreditsStdout
      .trimEnd()
      .split("\n")
      .slice(0, 5)
      .join("\n");
    const successfulMessage = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: `${markerOpen(PI_FIXTURE_NONCE)}\n${validGuide}\n${markerClose(PI_FIXTURE_NONCE)}`,
        }],
        stopReason: "stop",
      },
    });
    const session = createGuideSession();

    const result = await session.onJobComplete({
      job: {
        id: jobId,
        engine: "pi",
        prompt: composeGuideMarkerPrompt("Review the changed files.", PI_FIXTURE_NONCE),
      },
      meta: { stdout: `${transientErrorPrefix}\n${successfulMessage}\n` },
      changedFiles: FILES,
    });

    expect(result.error).toBeUndefined();
    expect(result.summary?.correctness).toBe("Guide Generated");
    expect(session.getGuide(jobId)?.sections[0].title).toBe("Recovered");
  });
});
