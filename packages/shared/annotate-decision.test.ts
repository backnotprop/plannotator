import { describe, expect, test } from "bun:test";
import { createAnnotateDecisionSettler, isNothingToSendFeedbackBody } from "./annotate-decision";

describe("annotate decision settler", () => {
  test("the first producer wins and resolves exactly once", () => {
    const resolved: string[] = [];
    const decision = createAnnotateDecisionSettler<string>((d) => resolved.push(d));

    expect(decision.settle("approved")).toBe(true);
    expect(decision.isSettled()).toBe(true);
    expect(resolved).toEqual(["approved"]);
  });

  test("a later producer loses and cannot resolve", () => {
    const resolved: string[] = [];
    const decision = createAnnotateDecisionSettler<string>((d) => resolved.push(d));

    decision.settle("dismissed");

    expect(decision.settle("approved")).toBe(false);
    expect(decision.settle("annotated")).toBe(false);
    expect(resolved).toEqual(["dismissed"]);
  });

  test("nothing is settled before the first producer", () => {
    const decision = createAnnotateDecisionSettler<string>(() => {});
    expect(decision.isSettled()).toBe(false);
  });
});

describe("isNothingToSendFeedbackBody", () => {
  test("only an explicit flag on a body with no annotations reads as nothing to send", () => {
    expect(isNothingToSendFeedbackBody({ feedback: "x", annotations: [], codeAnnotations: [], nothingToSend: true })).toBe(true);
    expect(isNothingToSendFeedbackBody({ feedback: "x", nothingToSend: true })).toBe(true);
    // A body carrying annotations is never "nothing", whatever it claims.
    expect(isNothingToSendFeedbackBody({ annotations: [{}], nothingToSend: true })).toBe(false);
    expect(isNothingToSendFeedbackBody({ codeAnnotations: [{}], nothingToSend: true })).toBe(false);
    // Strictly boolean true; an older editor sends no flag at all.
    expect(isNothingToSendFeedbackBody({ annotations: [], nothingToSend: "true" })).toBe(false);
    expect(isNothingToSendFeedbackBody({ annotations: [] })).toBe(false);
    expect(isNothingToSendFeedbackBody(null)).toBe(false);
  });
});
