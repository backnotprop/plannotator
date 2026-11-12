import { describe, expect, test } from "bun:test";
import {
  buildDecisionSpec,
  type DecisionSpecInput,
} from "@plannotator/ui/utils/decisionSpec";
import {
  compactPrimaryIdForDecision,
  compactRowIdForDecisionItem,
  resolveAnnotateDecisionAction,
} from "./annotateDecision";

function annotateInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const gate of [false, true])
    for (const hasFeedback of [false, true])
      for (const approvalNotesSupported of [false, true])
        for (const count of [0, 1, 3])
          inputs.push({ app: "annotate", gate, count, hasFeedback, approvalNotesSupported });
  return inputs;
}

describe("annotate decision handler exhaustiveness", () => {
  test("every id the spec can emit resolves to a route", () => {
    for (const input of annotateInputs()) {
      const spec = buildDecisionSpec(input);
      expect(resolveAnnotateDecisionAction("primary", { gate: input.gate })).toBeDefined();
      for (const item of spec.items) {
        const route = resolveAnnotateDecisionAction(item.id, { gate: input.gate });
        expect(route).toBeDefined();
        if (item.composer) expect(route.kind).toBe("note");
        if (item.confirm) expect(route.kind).toBe("discard");
      }
    }
  });

  test("note and discard routes follow the gate's transport; no menu note ever carries approval framing", () => {
    const gated = { gate: true };
    const ungated = { gate: false };

    expect(resolveAnnotateDecisionAction("note-with-approval", gated))
      .toEqual({ kind: "note", route: "approve", approvalFraming: false });
    for (const input of annotateInputs()) {
      if (input.gate) continue;
      expect(buildDecisionSpec(input).items.map((item) => item.id))
        .not.toContain("note-with-approval");
    }
    expect(resolveAnnotateDecisionAction("note-with-approval", ungated))
      .toEqual({ kind: "note", route: "feedback", approvalFraming: false });

    for (const ctx of [gated, ungated]) {
      expect(resolveAnnotateDecisionAction("request-changes", ctx))
        .toEqual({ kind: "note", route: "feedback", approvalFraming: false });
      expect(resolveAnnotateDecisionAction("note-with-feedback", ctx))
        .toEqual(resolveAnnotateDecisionAction("request-changes", ctx));
    }

    expect(resolveAnnotateDecisionAction("discard-and-finish", gated))
      .toEqual({ kind: "discard", route: "approve" });
    expect(resolveAnnotateDecisionAction("discard-and-finish", ungated))
      .toEqual({ kind: "discard", route: "feedback" });
  });

  test("compact row ids are unique per spec and never collide with the primary row", () => {
    for (const input of annotateInputs()) {
      const spec = buildDecisionSpec(input);
      const ids = [
        compactPrimaryIdForDecision(spec.primary),
        ...spec.items.map((item) => compactRowIdForDecisionItem(item.id)),
      ];
      for (const id of ids) expect(id).toBeDefined();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
