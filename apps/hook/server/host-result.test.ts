import { describe, expect, test } from "bun:test";
import { annotateContextLine, annotateHostResult, isAllowedHostResultPath, planHostResult, reviewHostResult, takeHostResultPath, HOST_RESULT_FILE_ENV } from "./host-result";
import { buildReviewOutput } from "./review-output";
import { formatAnnotateOutcome } from "./annotate-output";
import { deliveryFor } from "../hooks/mod/delivery";

describe("reviewHostResult", () => {
  test("LGTM and Close never reach the agent; feedback does, as the CLI prints it", () => {
    const lgtm = { approved: true, feedback: "", annotations: [] };
    expect(reviewHostResult(lgtm, buildReviewOutput(lgtm, "claude-code"))).toMatchObject({ decision: "approved", noop: true });

    const closed = { approved: false, feedback: "", annotations: [], exit: true };
    expect(reviewHostResult(closed, buildReviewOutput(closed, "claude-code"))).toMatchObject({ decision: "dismissed", noop: true });

    const changes = { approved: false, feedback: "## src/a.ts\nline 3: wrong", annotations: [{}, {}] };
    const output = buildReviewOutput(changes, "claude-code");
    expect(reviewHostResult(changes, output)).toEqual({
      v: 1, surface: "review", decision: "annotated", message: output.message, noop: false, annotationCount: 2,
    });
  });

  test("approve with a note reaches the agent with the notes framing", () => {
    const withNote = { approved: true, feedback: "Rename the helper later.", annotations: [] };
    const record = reviewHostResult(withNote, buildReviewOutput(withNote, "claude-code"));
    expect(record.noop).toBe(false);
    expect(record.message).toContain("Rename the helper later.");
  });

  test("a review posted to the PR platform is marked so the host only logs it", () => {
    const status = "Pull request reviewed on GitHub: https://github.com/o/r/pull/1";
    const posted = { approved: false, feedback: status, annotations: [], platform: true };
    const record = reviewHostResult(posted, buildReviewOutput(posted, "claude-code"));
    expect(record).toMatchObject({ decision: "annotated", noop: true, platform: true });
    // The status line, never the request-changes suffix.
    expect(record.message).toBe(status);
  });

  // The review editor sends only code comments in `annotations`; PR
  // description comments, PR comment notes and VS Code editor comments ride
  // only in `feedback`. Zero annotations must therefore never read as the
  // platform post (that silently dropped these reviews under the mod).
  test.each([
    ["PR description comments", "## PR description\n\n> Adds the parser\n\nExplain why the fallback exists."],
    ["PR comment notes", "## PR comments\n\n> @alice: looks risky\n\nAgree, split this."],
    ["VS Code editor comments", "# Editor Annotations\n\n## src/a.ts:3\n\nRename this."],
  ])("feedback made only of %s is delivered", (_label, feedback) => {
    const result = { approved: false, feedback, annotations: [] };
    const output = buildReviewOutput(result, "claude-code");
    const record = reviewHostResult(result, output);
    expect(record).toMatchObject({ decision: "annotated", noop: false, annotationCount: 0 });
    expect(record.platform).toBeUndefined();
    expect(record.message).toBe(output.message);
    expect(record.message).toContain(feedback);
  });

  // End to end on the mod path: the record the CLI writes for such feedback
  // reaches the mod's delivery decision as a turn, while the marked platform
  // post still only logs with the follow-up suggestion.
  test("the mod submits zero-annotation feedback and only logs the platform post", () => {
    const context = { subject: "PR #1", overflowPath: "/data/x/feedback.md" };
    const descriptionOnly = { approved: false, feedback: "## PR description\n\nExplain the fallback.", annotations: [] };
    const delivered = deliveryFor(reviewHostResult(descriptionOnly, buildReviewOutput(descriptionOnly, "claude-code")), context);
    expect(delivered.action).toBe("submit");
    expect(delivered.action === "submit" && delivered.text).toContain("Explain the fallback.");

    const posted = { approved: false, feedback: "Pull request reviewed on GitHub: https://github.com/o/r/pull/1", annotations: [], platform: true };
    const logged = deliveryFor(reviewHostResult(posted, buildReviewOutput(posted, "claude-code")), context);
    expect(logged.action).toBe("log");
    expect(logged.action === "log" && logged.suggest).toBe("address the review comments on PR #1");
  });

  test("an empty submit with no annotations stays a no-op", () => {
    const empty = { approved: false, feedback: "  ", annotations: [] };
    const record = reviewHostResult(empty, buildReviewOutput(empty, "claude-code"));
    expect(record).toMatchObject({ decision: "annotated", noop: true, annotationCount: 0 });
    expect(record.platform).toBeUndefined();
  });
});

describe("annotateHostResult", () => {
  // Failure caught: plaintext stdout and the result file naming the target of
  // an approval with notes differently (they share annotateContextLine).
  test("an approval with notes reads the same on stdout and in the result file", () => {
    const config = { prompts: { annotate: { approvedWithNotes: "{{context}} || {{feedback}}" } } };
    const outcome = { approved: true, feedback: "ship it after the rename", annotations: [] };
    const contexts = [
      { kind: "file", target: "/repo/page.html" },
      { kind: "folder", target: "/repo/docs" },
      { kind: "url", target: "https://example.com/a" },
      { kind: "bundle", bundlePaths: ["/repo/a.md", "/repo/b.md"] },
      { kind: "last" },
    ] as const;
    const lines = contexts.map((context) => {
      const record = annotateHostResult(outcome, { ...context, config });
      const stdout = formatAnnotateOutcome(outcome, { hook: false, json: false }, { context: annotateContextLine(context), config });
      expect(record.message).toBe(stdout!);
      return annotateContextLine(context);
    });
    expect(lines.map((line) => line.split(":")[0])).toEqual(["File", "Folder", "URL", "Files", ""]);
    expect(lines[0]).toBe("File: /repo/page.html");
    expect(lines[3]).toContain("/repo/a.md");
    expect(lines[3]).toContain("/repo/b.md");
  });

  test("file feedback carries the annotate prompt with the file named", () => {
    const record = annotateHostResult({ feedback: "1. tighten intro", annotations: [{}] }, { kind: "file", target: "/repo/notes.md" });
    expect(record).toMatchObject({ surface: "annotate", decision: "annotated", noop: false, annotationCount: 1 });
    expect(record.message).toContain("/repo/notes.md");
    expect(record.message).toContain("1. tighten intro");
  });

  test("Done with nothing and Close are no-ops; last-message feedback uses the message prompt", () => {
    expect(annotateHostResult({ feedback: "", annotations: [] }, { kind: "file", target: "/a.md" }).noop).toBe(true);
    expect(annotateHostResult({ feedback: "", exit: true }, { kind: "last" })).toMatchObject({ surface: "annotate-last", decision: "dismissed", noop: true });
    const last = annotateHostResult({ feedback: "shorter please" }, { kind: "last" });
    expect(last.message).toContain("shorter please");
    expect(last.message).not.toContain("{{");
  });

  // #1701: the editor's Done posts the zero-state sentence as feedback and
  // marks the body; that must not start a turn on either surface.
  test("a Done marked nothingToSend is a no-op even though feedback carries the sentence", () => {
    const sentence = "User reviewed the document and has no feedback.";
    for (const kind of ["file", "folder", "last"] as const) {
      const record = annotateHostResult({ feedback: sentence, annotations: [], nothingToSend: true }, { kind, target: "/a.md" });
      expect(record).toMatchObject({ decision: "annotated", noop: true, message: "", annotationCount: 0 });
    }
  });
});

describe("takeHostResultPath", () => {
  test("scrubs the variable so nothing the server spawns inherits it", () => {
    // Module state is taken once per process; use a private env object.
    const env: NodeJS.ProcessEnv = { [HOST_RESULT_FILE_ENV]: "/tmp/r.json" };
    const before = takeHostResultPath(env);
    expect(env[HOST_RESULT_FILE_ENV]).toBeUndefined();
    // The first call in this process decides; later calls return the same value.
    expect(takeHostResultPath({})).toBe(before);
  });
});

// The failure: any process that could set the variable made the CLI create
// or replace an arbitrary file (rename onto ~/.bashrc, mkdir -p anywhere).
describe("isAllowedHostResultPath", () => {
  test("only a result.json inside <data dir>/claude-code-mod/", () => {
    const data = "/home/me/.plannotator";
    expect(isAllowedHostResultPath(`${data}/claude-code-mod/s/l/result.json`, data)).toBe(true);
    expect(isAllowedHostResultPath("/home/me/.bashrc", data)).toBe(false);
    expect(isAllowedHostResultPath(`${data}/claude-code-mod/s/l/other.json`, data)).toBe(false);
    expect(isAllowedHostResultPath(`${data}/claude-code-mod/../config.json`, data)).toBe(false);
    expect(isAllowedHostResultPath(`${data}/claude-code-mod/../../x/result.json`, data)).toBe(false);
    expect(isAllowedHostResultPath("claude-code-mod/s/result.json", data)).toBe(false);
    expect(isAllowedHostResultPath(`${data}/claude-code-mod-evil/result.json`, data)).toBe(false);
  });
});

// The failure: a review the agent closed reads, to the host, like the
// reviewer's own Close, and the unsent count the agent was told is lost.
describe("host close", () => {
  test("an agent close is a dismissal marked closedBy, with the unsent count", () => {
    const review = { approved: false, feedback: "", annotations: [], exit: true, closedBy: "agent" as const, unsentAnnotations: 2 };
    expect(reviewHostResult(review, buildReviewOutput(review, "claude-code"))).toMatchObject({ decision: "dismissed", noop: true, closedBy: "agent", unsentAnnotations: 2 });
    expect(annotateHostResult({ feedback: "", exit: true, closedBy: "agent", unsentAnnotations: 0 }, { kind: "file", target: "/a.md" })).toMatchObject({ decision: "dismissed", closedBy: "agent", unsentAnnotations: 0 });
    expect(annotateHostResult({ feedback: "", exit: true }, { kind: "file", target: "/a.md" })).not.toHaveProperty("closedBy");
  });
});

// The failure this guards: a bare approval record carried no path, so the
// agent named the decision after an earlier one about a different file of the
// same name. Every record now names the target the SUBMITTING server resolved.
describe("decision target", () => {
  test("annotate records name the file, folder, URL or bundle in full; annotate-last names none", () => {
    expect(annotateHostResult({ approved: true, feedback: "" }, { kind: "file", target: "/w/releases-2026-10-04/QUESTIONS.md" }))
      .toMatchObject({ decision: "approved", noop: true, target: "/w/releases-2026-10-04/QUESTIONS.md" });
    expect(annotateHostResult({ feedback: "x" }, { kind: "folder", target: "/w/docs" }).target).toBe("/w/docs");
    expect(annotateHostResult({ feedback: "x" }, { kind: "url", target: "https://example.com/a" }).target).toBe("https://example.com/a");
    expect(annotateHostResult({ feedback: "", exit: true }, { kind: "bundle", bundlePaths: ["/w/a.md", "/w/b.md"] }).target)
      .toEqual(["/w/a.md", "/w/b.md"]);
    expect(annotateHostResult({ feedback: "x" }, { kind: "last", target: "/ignored" })).not.toHaveProperty("target");
  });

  test("review and plan records name the reviewed directory or PR and the plan file", () => {
    const lgtm = { approved: true, feedback: "", annotations: [] };
    expect(reviewHostResult(lgtm, buildReviewOutput(lgtm, "claude-code"), { target: "https://github.com/o/r/pull/7" }).target)
      .toBe("https://github.com/o/r/pull/7");
    expect(reviewHostResult(lgtm, buildReviewOutput(lgtm, "claude-code"))).not.toHaveProperty("target");
    expect(planHostResult({ approved: true }, { approvedPlan: "# p", planFilePath: "/home/u/.claude/plans/p.md" }).target)
      .toBe("/home/u/.claude/plans/p.md");
    expect(planHostResult({ approved: false, feedback: "no" }, { approvedPlan: "# p" })).not.toHaveProperty("target");
  });

  test("the mod's turn for a bare gated approval names the full path, not just the file name", () => {
    const record = annotateHostResult({ approved: true, feedback: "" }, { kind: "file", target: "/w/releases-2026-10-04/QUESTIONS.md" });
    const delivery = deliveryFor(JSON.parse(JSON.stringify(record)), {
      subject: "QUESTIONS.md",
      sessionId: "pn-abc123",
      overflowPath: "/tmp/feedback.md",
      deliverApproval: true,
    });
    expect(delivery.action).toBe("submit");
    expect(delivery.text.split("\n").slice(0, 2)).toEqual([
      "Plannotator: QUESTIONS.md (pn-abc123) — Approved.",
      "Target: /w/releases-2026-10-04/QUESTIONS.md",
    ]);
  });
});
