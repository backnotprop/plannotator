const { afterEach, beforeEach, describe, expect, test } = require("bun:test");
const { emitAnnotateDecision } = require("./run-plannotator");

// #1137: approved decisions carrying Approve-with-Notes feedback (#1092) were
// collapsed to a bare "Approved." and the reviewer's notes were silently
// dropped. These tests pin the full decision -> stdout contract.
describe("emitAnnotateDecision", () => {
  let written;
  let originalWrite;

  beforeEach(() => {
    written = [];
    originalWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  const output = () => written.join("");

  test("plain approval still prints Approved.", () => {
    emitAnnotateDecision('{"decision":"approved"}', "Markdown Annotations");
    expect(output()).toBe("Approved.\n");
  });

  test("approved-with-notes surfaces the feedback instead of dropping it", () => {
    emitAnnotateDecision(
      JSON.stringify({
        decision: "approved",
        feedback: "Ship it, but rename the flag before GA.",
      }),
      "Markdown Annotations",
    );

    expect(output()).toBe(
      "# Approved with Notes\n\nThe artifact is approved. The notes below are non-blocking guidance, not a request for another revision.\n\nShip it, but rename the flag before GA.\n\nDo not revise or reopen the artifact solely because of these notes unless the user explicitly requests it. Carry the notes into subsequent work where applicable.\n",
    );
  });

  test("approved with blank feedback prints Approved.", () => {
    emitAnnotateDecision('{"decision":"approved","feedback":"   "}', "Markdown Annotations");
    expect(output()).toBe("Approved.\n");
  });

  test("dismissed decision closes the session", () => {
    emitAnnotateDecision('{"decision":"dismissed"}', "Markdown Annotations");
    expect(output()).toBe("Annotation session closed.\n");
  });

  test("annotated decision wraps feedback under the heading", () => {
    emitAnnotateDecision(
      '{"decision":"annotated","feedback":"Comment: tighten this section."}',
      "Markdown Annotations",
    );
    expect(output()).toBe(
      "# Markdown Annotations\n\nComment: tighten this section.\n\nPlease address the annotation feedback above.\n",
    );
  });

  test("empty output closes the session", () => {
    emitAnnotateDecision("", "Markdown Annotations");
    expect(output()).toBe("Annotation session closed.\n");
  });

  test("non-JSON output falls back to raw passthrough", () => {
    emitAnnotateDecision("plain text feedback", "Markdown Annotations");
    expect(output()).toBe("plain text feedback\n");
  });
});
