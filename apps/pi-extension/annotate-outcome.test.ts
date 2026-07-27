import { describe, expect, test } from "bun:test";
import { classifyAnnotateOutcome } from "./annotate-outcome.ts";

describe("Pi annotate outcomes", () => {
  test("delivers approved file feedback before the approval notification", () => {
    expect(classifyAnnotateOutcome({
      feedback: "Keep the retry bounded.",
      approved: true,
    })).toEqual({
      feedback: "Keep the retry bounded.",
      notification: "approved",
      promptKind: "approved-with-notes",
    });
  });

  test("delivers approved last-message feedback before the approval notification", () => {
    expect(classifyAnnotateOutcome({
      feedback: "Retain this caveat.",
      approved: true,
      selectedMessageId: "message-2",
    })).toEqual({
      feedback: "Retain this caveat.",
      notification: "approved",
      promptKind: "approved-with-notes",
    });
  });

  test("keeps no-feedback approval as a notification-only outcome", () => {
    expect(classifyAnnotateOutcome({
      feedback: "",
      approved: true,
    })).toEqual({
      feedback: null,
      notification: "approved",
      promptKind: null,
    });
  });

  test("keeps ordinary feedback and exits distinct", () => {
    expect(classifyAnnotateOutcome({ feedback: "Revise this." })).toEqual({
      feedback: "Revise this.",
      notification: null,
      promptKind: "feedback",
    });
    expect(classifyAnnotateOutcome({ feedback: "", exit: true })).toEqual({
      feedback: null,
      notification: "closed",
      promptKind: null,
    });
  });
});
