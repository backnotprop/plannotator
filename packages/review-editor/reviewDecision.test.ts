/**
 * Handler exhaustiveness for the review (agent-mode) decision wiring
 * (spec §8C, pure lane — cannot silently skip).
 *
 * Neither app package is typechecked (spec §9), so the contract "every id the
 * spec can emit has a route" is enforced here at runtime: an id added to
 * `decisionSpec.ts` without a branch in `resolveReviewDecisionAction` (or the
 * compact row mapper) returns `undefined` and fails these sweeps.
 */
import { describe, expect, test } from "bun:test";
import {
  buildDecisionSpec,
  type DecisionSpecInput,
} from "@plannotator/ui/utils/decisionSpec";
import {
  buildReviewApprovalBody,
  compactPrimaryIdForReviewDecision,
  compactRowIdForReviewDecisionItem,
  createGeneralReviewComment,
  readApprovalNotesAdvert,
  resolvePlatformDecisionAction,
  resolveReviewDecisionAction,
} from "./reviewDecision";
import { annotationMatchesPrScope } from "./utils/annotationScope";

/** Every input combination the review app can hand the spec builder — the
 *  advert swept both ways, so neither advert state can surface an unrouted
 *  id. */
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

/** Every input combination platform (PR) mode can hand the spec builder —
 *  self-authorship swept both ways (PR6, §3.4). */
function platformInputs(): DecisionSpecInput[] {
  const inputs: DecisionSpecInput[] = [];
  for (const selfAuthored of [false, true])
    for (const count of [0, 1, 3])
      inputs.push({
        app: "review",
        gate: true,
        count,
        hasFeedback: count > 0,
        approvalNotesSupported: false, // ignored by the platform arm
        platform: { label: "GitHub", mrLabel: "PR", selfAuthored },
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
        // A composer item routed anywhere but a note-carrying flow would drop
        // the typed note on the floor; a confirm item must be the discard
        // flow (the one remaining guard dialog).
        if (item.composer) {
          expect(["note", "approve-with-notes"]).toContain(route.kind);
        }
        if (item.confirm) expect(route.kind).toBe("discard");
      }
    }
  });

  // Guards the single-transport matrix (spec §3.2/§6.1): request-changes and
  // note-with-feedback differ only by state, never by route; the confirm item
  // is the discard flow; both approve-carrying ids land on the PR5 delivery
  // path — routing one to the plain-note flow would misdeliver an approval as
  // a change request — and fork only on WHAT rides the approval.
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

  // The PR5 contract (spec §6.4), extended from PR3's tripwire exactly as its
  // comment instructed: the advert may only emit approve-carrying ids whose
  // route DELIVERS the content. The refusal marker is gone, so the assertion
  // is now about the wire body: under a true advert every approve-carrying
  // item builds an approval payload that carries the reviewer's content —
  // the composer note as the feedback, or the live annotations + their
  // export — never an empty body and never the removed LGTM placeholder.
  test("under a true advert, every approve-carrying item's payload delivers the content", () => {
    const EXPORT = "# Code Review Feedback\n\n## General\n\n- overall note\n";
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
      // A true advert must actually light an approve-carrying item in both
      // states — otherwise delivery shipped but the menu never offers it.
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
          // "Approve with notes": the annotations ride for archive
          // provenance, and their export is the feedback the consumer prints
          // after the approved prompt.
          expect(body.feedback).toBe(EXPORT);
          expect(body.annotations).toEqual([NOTE_ANNOTATION]);
        } else {
          // "Approve with a note…": the note IS the feedback.
          expect(body.feedback).toBe("ship it, but rename the flag");
          expect(body.annotations).toEqual([]);
        }
      }
    }
  });

  // Compatibility matrix (spec §6.4): old server / new client — a payload
  // without the field reads false, so no approve-carrying item renders (the
  // PR3 behavior); and the new bare approval sends `feedback: ''` instead of
  // the removed LGTM placeholder, which is what makes the archive's `lgtm`
  // decision reachable and stops bare approvals writing sidecars.
  test("absent advert reads false, and a bare approval carries no placeholder", () => {
    expect(readApprovalNotesAdvert(undefined)).toBe(false);
    // Only a literal true is capable — a truthy string or number is not.
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

  // Stage-review m2: a note must never be silently discarded because
  // annotations also ride — a future combined item (composer note + live
  // annotations) folds the note in ahead of the export.
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

  // Guards the compact surface: row ids double as React keys, so a collision
  // hides a decision row on touch — the silent-data-loss class the #1436
  // review flagged (E16-review).
  test("compact row ids are unique per spec and never collide with the primary row", () => {
    for (const input of [...reviewInputs(), ...platformInputs()]) {
      const spec = buildDecisionSpec(input);
      const ids = [
        compactPrimaryIdForReviewDecision(spec.primary),
        ...spec.items.map((item) => compactRowIdForReviewDecisionItem(item.id)),
      ];
      for (const id of ids) expect(id).toBeDefined();
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // PR6 (§3.4) exhaustiveness, same failure class as the agent sweep: an id
  // the platform arm starts emitting without a dialog-mode route resolves to
  // null and its menu row silently does nothing. The mode itself must match
  // the row's meaning — an approve-flavoured row landing in comment mode
  // would post a review where the reviewer asked to approve.
  test("every id the platform arm emits resolves to the matching dialog mode", () => {
    for (const input of platformInputs()) {
      const spec = buildDecisionSpec(input);
      expect(resolvePlatformDecisionAction("primary", input.count > 0))
        .toBe(input.count > 0 ? "comment" : "approve");
      for (const item of spec.items) {
        const mode = resolvePlatformDecisionAction(item.id, input.count > 0);
        expect(mode).toBe(item.tone === "success" ? "approve" : "comment");
      }
    }
  });
});

describe("createGeneralReviewComment — the one review-level comment shape", () => {
  // Guards the transport shape both human producers (header note + sidebar
  // "+ General comment") depend on: the ''/0/0 sentinels keep it out of every
  // file group and the payload tests pin the same shape on the wire.
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
    // Two commits in one millisecond must not collide: the deferred-submit
    // effect keys on the id (spec §9 — why randomUUID, not Date.now()).
    expect(createGeneralReviewComment("a")!.id).not.toBe(createGeneralReviewComment("a")!.id);
  });

  test("a whitespace-only note never commits, and a missing identity omits author", () => {
    expect(createGeneralReviewComment("   \n  ")).toBeNull();
    expect(createGeneralReviewComment("")).toBeNull();
    expect("author" in createGeneralReviewComment("x", "")!).toBe(false);
  });

  // Guards the PR-switch survival the spec's PR4 hunt names: the comment
  // carries no prUrl/diffScope, so it passes every PR scope predicate and a
  // switched-to PR still renders and exports it.
  test("survives an in-place PR switch: no PR context, passes every PR scope", () => {
    const note = createGeneralReviewComment("overall note")!;
    expect(note.prUrl).toBeUndefined();
    expect(note.diffScope).toBeUndefined();
    expect(annotationMatchesPrScope(note, "https://github.com/o/r/pull/7", "layer")).toBe(true);
    expect(annotationMatchesPrScope(note, undefined, undefined)).toBe(true);
  });
});
