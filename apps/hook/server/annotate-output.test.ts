import { describe, expect, test } from "bun:test";
import {
  formatAnnotateOutcome,
  supportsAnnotateApprovalNotes,
} from "./annotate-output";

describe("annotate stdout", () => {
  test("preserves legacy plaintext output byte-for-byte", () => {
    expect(formatAnnotateOutcome(
      { feedback: "", approved: true },
      { hook: false, json: false },
    )).toBe("The user approved.");
    expect(formatAnnotateOutcome(
      { feedback: "", exit: true },
      { hook: false, json: false },
    )).toBeNull();
    expect(formatAnnotateOutcome(
      { feedback: "Revise this.", approved: false },
      { hook: false, json: false },
    )).toBe("Revise this.");
  });

  test("preserves legacy hook output byte-for-byte", () => {
    expect(formatAnnotateOutcome(
      { feedback: "Keep the retry bounded.", approved: true },
      { hook: true, json: true },
    )).toBeNull();
    expect(formatAnnotateOutcome(
      { feedback: "Revise this." },
      { hook: true, json: false },
    )).toBe('{"decision":"block","reason":"Revise this."}');
  });

  test("includes nonempty feedback only on direct JSON approval", () => {
    expect(formatAnnotateOutcome(
      { feedback: "Keep the retry bounded.", approved: true },
      { hook: false, json: true },
    )).toBe('{"decision":"approved","feedback":"Keep the retry bounded."}');
    expect(formatAnnotateOutcome(
      { feedback: "", approved: true },
      { hook: false, json: true },
    )).toBe('{"decision":"approved"}');
  });

  test("advertises approval notes only for gated direct JSON", () => {
    expect(supportsAnnotateApprovalNotes({ gate: true, json: true, hook: false })).toBe(true);
    expect(supportsAnnotateApprovalNotes({ gate: false, json: true, hook: false })).toBe(false);
    expect(supportsAnnotateApprovalNotes({ gate: true, json: false, hook: false })).toBe(false);
    expect(supportsAnnotateApprovalNotes({ gate: true, json: true, hook: true })).toBe(false);
  });
});
