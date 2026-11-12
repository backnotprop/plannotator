import type { DecisionActionId, DecisionMenuItem, DecisionPrimary } from "@plannotator/ui/utils/decisionSpec";
import type { CompactPlanAction } from "@plannotator/ui/components/PlanHeaderMenu";

export type AnnotateDecisionRoute =
  | { kind: "primary" }
  | { kind: "note"; route: "feedback" | "approve"; approvalFraming: boolean }
  | { kind: "approve-with-notes" }
  | { kind: "discard"; route: "feedback" | "approve" };

export function resolveAnnotateDecisionAction(
  id: DecisionActionId,
  ctx: { gate: boolean },
): AnnotateDecisionRoute {
  switch (id) {
    case "primary":
      return { kind: "primary" };
    case "note-with-approval":
      return ctx.gate
        ? { kind: "note", route: "approve", approvalFraming: false }
        : { kind: "note", route: "feedback", approvalFraming: false };
    case "request-changes":
    case "note-with-feedback":
      // The two differ only by state (empty vs feedback), never by transport.
      return { kind: "note", route: "feedback", approvalFraming: false };
    case "approve-with-notes":
      return { kind: "approve-with-notes" };
    case "discard-and-finish":
      return ctx.gate
        ? { kind: "discard", route: "approve" }
        : { kind: "discard", route: "feedback" };
  }
}

export function compactRowIdForDecisionItem(
  id: DecisionMenuItem["id"],
): Extract<CompactPlanAction["id"], "note" | "feedback" | "approve" | "discard-finish"> {
  switch (id) {
    case "note-with-approval":
    case "note-with-feedback":
      return "note";
    case "request-changes":
      return "feedback";
    case "approve-with-notes":
      return "approve";
    case "discard-and-finish":
      return "discard-finish";
  }
}

export function compactPrimaryIdForDecision(
  primary: Pick<DecisionPrimary, "icon">,
): Extract<CompactPlanAction["id"], "feedback" | "approve"> {
  return primary.icon === "send" ? "feedback" : "approve";
}
