import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  GUIDE_NO_SECTIONS_ERROR,
  GUIDE_REVIEW_PROMPT,
  buildGuideMarkerOutputContract,
  buildGuideUserMessage,
  composeGuideMarkerPrompt,
  composeGuideMethodology,
  createGuideSession,
  repairGuideJsonText,
  validateGuideOutput,
  parseGuideStreamOutput,
} from "./guide-review";
import { GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS } from "@plannotator/shared/guide";
import type { DiffType } from "../vcs";
import { extractMarkerNonce, markerClose, markerOpen } from "../marker-review";

// Pins the behaviors the PR-993 review rounds fixed. This module previously
// had NO direct coverage — the repair ladder and validation are pure logic
// exercised only end-to-end through live agent runs, which is exactly where
// regressions hide.

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts"];
const PI_FIXTURE_NONCE = "pn0123456789ab";
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

  it("explains a fully-invalidated guide whose refs were outside the changeset (count + example paths)", () => {
    // The model guided a different commit than the one under review — the
    // failure card must say so instead of the bare generic message. Asserts
    // the data the message carries (count, example paths, the Commits-panel
    // pointer), not the surrounding prose.
    const raw = JSON.parse(
      guideJson([
        { title: "X", overview: "o", diffs: [{ file: "other/one.ts" }, { file: "other/two.ts" }] },
        { title: "Y", overview: "o", diffs: [{ file: "other/three.ts" }, { file: "other/four.ts" }] },
      ]),
    );
    const result = validateGuideOutput(raw, FILES);
    if (!("error" in result)) throw new Error("expected a validation error");
    expect(result.error).toContain("4 file(s) outside the changeset");
    expect(result.error).toContain("other/one.ts");
    expect(result.error).toContain("Commits panel");
    // Examples are capped at 3 — the fourth path must not be listed.
    expect(result.error).not.toContain("other/four.ts");
  });

  it("keeps the generic message for genuinely structural emptiness (no outside-changeset drops)", () => {
    const noSections = validateGuideOutput(JSON.parse(guideJson([])), FILES);
    if (!("error" in noSections)) throw new Error("expected a validation error");
    expect(noSections.error).toBe(GUIDE_NO_SECTIONS_ERROR);

    // A zero-diff section with a blank overview dies structurally, not
    // because of the changeset — same generic message.
    const blankOverview = validateGuideOutput(
      JSON.parse(guideJson([{ title: "S", overview: "", diffs: [] }])),
      FILES,
    );
    if (!("error" in blankOverview)) throw new Error("expected a validation error");
    expect(blankOverview.error).toBe(GUIDE_NO_SECTIONS_ERROR);
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

describe("guide extra instructions (#1265)", () => {
  it("absent or blank instructions return the organizer prompt byte-identical", () => {
    expect(composeGuideMethodology()).toBe(GUIDE_REVIEW_PROMPT);
    expect(composeGuideMethodology("")).toBe(GUIDE_REVIEW_PROMPT);
    expect(composeGuideMethodology("   \n\t ")).toBe(GUIDE_REVIEW_PROMPT);
  });

  it("appends instructions after the full methodology, never replacing it", () => {
    const composed = composeGuideMethodology("Prefer product vocabulary over internal codenames.");
    expect(composed.startsWith(GUIDE_REVIEW_PROMPT)).toBe(true);
    expect(composed).toContain("## Additional reviewer instructions");
    expect(composed.endsWith("Prefer product vocabulary over internal codenames.")).toBe(true);
  });

  it("truncates instructions past the length cap", () => {
    const long = "A".repeat(GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS) + "OVERFLOW";
    const composed = composeGuideMethodology(long);
    expect(composed).toContain("A".repeat(GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS));
    expect(composed).not.toContain("OVERFLOW");
  });

  it("marker prompt without instructions keeps the exact pre-feature byte layout", () => {
    const nonce = PI_FIXTURE_NONCE;
    const expected =
      GUIDE_REVIEW_PROMPT + "\n\n" + buildGuideMarkerOutputContract(nonce) + "\n\n---\n\n" + "msg";
    expect(composeGuideMarkerPrompt("msg", nonce)).toBe(expected);
    expect(composeGuideMarkerPrompt("msg", nonce, "  ")).toBe(expected);
  });

  it("marker prompt with instructions carries the appended section before the output contract", () => {
    const composed = composeGuideMarkerPrompt("msg", PI_FIXTURE_NONCE, "Never invent ticket IDs.");
    const sectionAt = composed.indexOf("## Additional reviewer instructions");
    const contractAt = composed.indexOf("## Output contract");
    expect(sectionAt).toBeGreaterThan(-1);
    expect(contractAt).toBeGreaterThan(sectionAt);
    expect(composed).toContain("Never invent ticket IDs.");
  });

  it("nonce-shaped tags in instructions are defanged so first-match nonce recovery stays correct", () => {
    // The instructions section precedes the output contract, and
    // extractMarkerNonce takes the FIRST tag-shaped match in the prompt: a
    // pasted example tag would hijack recovery and fail a valid marker run.
    const evil = "Wrap output like <plannotator-review-json:pnabc123def456> as before.";
    expect(composeGuideMethodology(evil)).not.toMatch(/<\/?plannotator-review-json:pn[0-9a-f]{12}>/);
    expect(composeGuideMethodology(evil)).toContain("[marker tag removed]");
    const composed = composeGuideMarkerPrompt("msg", PI_FIXTURE_NONCE, evil);
    expect(extractMarkerNonce(composed)).toBe(PI_FIXTURE_NONCE);
  });

  it("buildCommand without instructions produces the exact prior claude prompt bytes", async () => {
    const session = createGuideSession();
    const built = await session.buildCommand({
      cwd: "/tmp",
      patch: "diff",
      diffType: "uncommitted" as DiffType,
      config: { engine: "claude" },
    });
    const userMessage = buildGuideUserMessage("diff", "uncommitted" as DiffType, undefined, undefined, undefined);
    expect(built.prompt).toBe(GUIDE_REVIEW_PROMPT + "\n\n---\n\n" + userMessage);
    expect(built.stdinPrompt).toBe(built.prompt);
  });

  it("buildCommand threads config.instructions into the claude prompt", async () => {
    const session = createGuideSession();
    const built = await session.buildCommand({
      cwd: "/tmp",
      patch: "diff",
      diffType: "uncommitted" as DiffType,
      config: { engine: "claude", instructions: "Use product names." },
    });
    expect(built.prompt).toContain("## Additional reviewer instructions");
    expect(built.prompt).toContain("Use product names.");
    expect(built.prompt!.startsWith(GUIDE_REVIEW_PROMPT)).toBe(true);
  });

  it("repair launches ignore instructions (mechanical fix, not a content rewrite)", async () => {
    const session = createGuideSession();
    const built = await session.buildCommand({
      cwd: "/tmp",
      patch: "diff",
      diffType: "uncommitted" as DiffType,
      config: { engine: "claude", instructions: "Use product names." },
      repair: { payload: "{}" },
    });
    expect(built.label).toBe("Guide Repair");
    expect(built.prompt).not.toContain("## Additional reviewer instructions");
    expect(built.prompt).not.toContain("Use product names.");
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

describe("createGuideSession launch review memo (portable export)", () => {
  const review = (n: number) => ({
    rawPatch: `diff --git a/f${n}.ts b/f${n}.ts\n`,
    gitRef: "HEAD",
    source: { kind: "local" as const },
  });

  it("records the launch review on the failure path too, so a repair or export sees the same diff", async () => {
    const session = createGuideSession();
    await session.onJobComplete({
      job: { id: "failed-1", engine: "pi", prompt: composeGuideMarkerPrompt("x", PI_FIXTURE_NONCE) },
      meta: { stdout: "not json" },
      changedFiles: FILES,
      launchReview: review(1),
    });
    expect(session.getGuide("failed-1")).toBeNull();
    expect(session.getLaunchReview("failed-1")).toEqual(review(1));
    expect(session.getLaunchReview("never")).toBeNull();
  });

  it("keeps only the most recent launch reviews (each carries a full patch)", async () => {
    const session = createGuideSession();
    for (let i = 0; i < 25; i++) {
      await session.onJobComplete({
        job: { id: `job-${i}`, engine: "pi", prompt: composeGuideMarkerPrompt("x", PI_FIXTURE_NONCE) },
        meta: { stdout: "not json" },
        changedFiles: FILES,
        launchReview: review(i),
      });
    }
    expect(session.launchReviews.size).toBe(20);
    expect(session.getLaunchReview("job-0")).toBeNull();
    expect(session.getLaunchReview("job-24")).toEqual(review(24));
  });
});
