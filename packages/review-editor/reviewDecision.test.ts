import { describe, expect, test } from "bun:test";
import {
  buildDecisionSpec,
  type DecisionSpecInput,
} from "@plannotator/ui/utils/decisionSpec";
import {
  buildReviewApprovalBody,
  compactPrimaryIdForReviewDecision,
  compactRowIdForReviewDecisionItem,
  compactRowIdForPlatformDecisionItem,
  createGeneralReviewComment,
  readApprovalNotesAdvert,
  resolvePlatformDecisionAction,
  resolveReviewDecisionAction,
} from "./reviewDecision";
import { annotationMatchesPrScope } from "./utils/annotationScope";

function reviewInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const approvalNotesSupported of [false, true])
    for (const count of [0, 1, 3])
      inputs.push({
        app: "review",
        gate: true,
        count,
        hasFeedback: count > 0,
        approvalNotesSupported,
      });
  return inputs;
}

function platformInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const [label, requestChangesSupported] of [["GitHub", true], ["GitLab", false]] as const)
    for (const selfAuthored of [false, true])
      for (const count of [0, 1, 3])
        inputs.push({
          app: "review",
          gate: true,
          count,
          hasFeedback: count > 0,
          approvalNotesSupported: false,
          platform: { label, mrLabel: label === "GitHub" ? "PR" : "MR", selfAuthored, requestChangesSupported },
        });
  return inputs;
}

describe("review decision handler exhaustiveness", () => {
  // Guards a menu item with no handler — the failure mode the missing app
  // typecheck would otherwise catch.
  test("every id the spec can emit resolves to a route", () => {
    for (const input of reviewInputs()) {
      const spec = buildDecisionSpec(input);
      expect(resolveReviewDecisionAction("primary")).toBeDefined();
      for (const item of spec.items) {
        const route = resolveReviewDecisionAction(item.id);
        expect(route).toBeDefined();
        // A composer item routed anywhere but a note-carrying flow would drop the typed note on the
        // floor; a confirm item must be the discard flow (the one remaining guard dialog).
        if (item.composer) {
          expect(["note", "approve-with-notes"]).toContain(route.kind);
        }
        if (item.confirm) expect(route.kind).toBe("discard");
      }
    }
  });

  test("the routes fork only on approved, never on which menu state emitted them", () => {
    expect(resolveReviewDecisionAction("note-with-feedback"))
      .toEqual(resolveReviewDecisionAction("request-changes"));
    expect(resolveReviewDecisionAction("request-changes").kind).toBe("note");
    expect(resolveReviewDecisionAction("discard-and-finish").kind).toBe("discard");
    expect(resolveReviewDecisionAction("note-with-approval"))
      .toEqual({ kind: "approve-with-notes", withAnnotations: false });
    expect(resolveReviewDecisionAction("approve-with-notes"))
      .toEqual({ kind: "approve-with-notes", withAnnotations: true });
  });

  test("under a true advert, every approve-carrying item's payload delivers the content", () => {
    const EXPORT = "# Code Review Feedback\n\n## Global comments\n\n- overall note\n";
    const NOTE_ANNOTATION = createGeneralReviewComment("overall note")!;
    for (const count of [0, 2]) {
      const spec = buildDecisionSpec({
        app: "review",
        gate: true,
        count,
        hasFeedback: count > 0,
        approvalNotesSupported: true,
      });
      const approveCarrying = spec.items.filter(
        (item) => resolveReviewDecisionAction(item.id).kind === "approve-with-notes",
      );
      expect(approveCarrying.length).toBeGreaterThan(0);
      for (const item of approveCarrying) {
        const route = resolveReviewDecisionAction(item.id);
        if (route.kind !== "approve-with-notes") throw new Error("unreachable");
        const body = buildReviewApprovalBody({
          draftGeneration: 1,
          note: item.composer ? "ship it, but rename the flag" : undefined,
          withAnnotations: route.withAnnotations,
          feedbackMarkdown: EXPORT,
          annotations: [NOTE_ANNOTATION],
        });
        expect(body.approved).toBe(true);
        if (route.withAnnotations) {
          expect(body.feedback).toBe(EXPORT);
          expect(body.annotations).toEqual([NOTE_ANNOTATION]);
        } else {
          expect(body.feedback).toBe("ship it, but rename the flag");
          expect(body.annotations).toEqual([]);
        }
      }
    }
  });

  test("absent advert reads false, and a bare approval carries no placeholder", () => {
    expect(readApprovalNotesAdvert(undefined)).toBe(false);
    expect(readApprovalNotesAdvert("true")).toBe(false);
    expect(readApprovalNotesAdvert(1)).toBe(false);
    expect(readApprovalNotesAdvert(true)).toBe(true);

    const spec = buildDecisionSpec({
      app: "review",
      gate: true,
      count: 2,
      hasFeedback: true,
      approvalNotesSupported: readApprovalNotesAdvert(undefined),
    });
    for (const item of spec.items) {
      expect(resolveReviewDecisionAction(item.id).kind).not.toBe("approve-with-notes");
    }

    const bare = buildReviewApprovalBody({
      draftGeneration: 3,
      withAnnotations: false,
      feedbackMarkdown: "# Code Review Feedback\n",
      annotations: [createGeneralReviewComment("x")!],
    });
    expect(bare).toEqual({ draftGeneration: 3, approved: true, feedback: "", annotations: [] });
  });

  test("a note riding beside annotations is folded ahead of the export, never dropped", () => {
    const body = buildReviewApprovalBody({
      draftGeneration: 1,
      note: "  ship it  ",
      withAnnotations: true,
      feedbackMarkdown: "# Code Review Feedback\n",
      annotations: [createGeneralReviewComment("x")!],
    });
    expect(body.feedback).toBe("ship it\n\n# Code Review Feedback\n");
    expect(body.annotations).toHaveLength(1);
  });

  test("compact row ids are unique per spec and never collide with the primary row", () => {
    const cases = [
      ...reviewInputs().map((input) => ({ input, rowId: compactRowIdForReviewDecisionItem })),
      ...platformInputs().map((input) => ({ input, rowId: compactRowIdForPlatformDecisionItem })),
    ];
    for (const { input, rowId } of cases) {
      const spec = buildDecisionSpec(input);
      const ids = [
        compactPrimaryIdForReviewDecision(spec.primary),
        ...spec.items.map((item) => rowId(item.id)),
      ];
      for (const id of ids) expect(id).toBeDefined();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("every id the platform arm emits resolves to the matching dialog mode", () => {
    for (const input of platformInputs()) {
      const supported = input.platform!.requestChangesSupported === true;
      const spec = buildDecisionSpec(input);
      expect(resolvePlatformDecisionAction("primary", input.count > 0, supported))
        .toEqual({ action: input.count > 0 ? "comment" : "approve", chooseEvent: false });
      for (const item of spec.items) {
        const mode = resolvePlatformDecisionAction(item.id, input.count > 0, supported);
        if (item.tone === "success") {
          expect(mode).toEqual({ action: "approve", chooseEvent: false });
        } else if (item.id === "request-changes") {
          expect(mode).toEqual({ action: supported ? "request_changes" : "comment", chooseEvent: true });
        } else {
          expect(mode).toEqual({ action: "comment", chooseEvent: true });
        }
      }
    }
  });

});

describe("createGeneralReviewComment — the one review-level comment shape", () => {
  test("commits a trimmed scope:'general' comment with the sentinel anchor", () => {
    const note = createGeneralReviewComment("  Split this into two PRs.  ", "ramos");
    expect(note).toMatchObject({
      type: "comment",
      scope: "general",
      filePath: "",
      lineStart: 0,
      lineEnd: 0,
      side: "new",
      text: "Split this into two PRs.",
      author: "ramos",
    });
    expect(createGeneralReviewComment("a")!.id).not.toBe(createGeneralReviewComment("a")!.id);
  });

  test("a whitespace-only note never commits, and a missing identity omits author", () => {
    expect(createGeneralReviewComment("   \n  ")).toBeNull();
    expect(createGeneralReviewComment("")).toBeNull();
    expect("author" in createGeneralReviewComment("x", "")!).toBe(false);
  });

  test("survives an in-place PR switch: no PR context, passes every PR scope", () => {
    const note = createGeneralReviewComment("overall note")!;
    expect(note.prUrl).toBeUndefined();
    expect(note.diffScope).toBeUndefined();
    expect(annotationMatchesPrScope(note, "https://github.com/o/r/pull/7", "layer")).toBe(true);
    expect(annotationMatchesPrScope(note, undefined, undefined)).toBe(true);
  });
});
