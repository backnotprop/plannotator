import { describe, expect, test } from "bun:test";
import { annotateHostResult, isAllowedHostResultPath, reviewHostResult, takeHostResultPath, HOST_RESULT_FILE_ENV } from "./host-result";
import { buildReviewOutput } from "./review-output";

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
    const posted = { approved: false, feedback: "Pull request reviewed on GitHub: https://github.com/o/r/pull/1", annotations: [] };
    expect(reviewHostResult(posted, buildReviewOutput(posted, "claude-code"))).toMatchObject({ noop: true, platform: true });
  });
});

describe("annotateHostResult", () => {
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
