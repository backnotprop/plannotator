import { describe, expect, test } from "bun:test";
import { classifyAnnotateOutcome, shouldPrependMessageAnchor } from "./annotate-outcome.ts";

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

describe("shouldPrependMessageAnchor (#1334)", () => {
  test("anchors a possibly-stale target by default", () => {
    expect(shouldPrependMessageAnchor({
      anchoringEnabled: true,
      targetMayBeStale: true,
    })).toBe(true);
  });

  test("skips anchoring when the config disables it", () => {
    expect(shouldPrependMessageAnchor({
      anchoringEnabled: false,
      targetMayBeStale: true,
    })).toBe(false);
  });

  test("skips anchoring when the target is the live last message", () => {
    expect(shouldPrependMessageAnchor({
      anchoringEnabled: true,
      targetMayBeStale: false,
    })).toBe(false);
  });

  test("message-scope feedback (picker, many messages) never anchors", () => {
    expect(shouldPrependMessageAnchor({
      feedbackScope: "messages",
      anchoringEnabled: true,
      targetMayBeStale: true,
    })).toBe(false);
    expect(shouldPrependMessageAnchor({
      feedbackScope: "message",
      anchoringEnabled: true,
      targetMayBeStale: true,
    })).toBe(true);
  });
});
