import type { DecisionActionId } from "@plannotator/ui/utils/decisionSpec";

export type PlanDecisionRoute =
  | { kind: "primary" }
  | { kind: "note"; route: "deny" | "approve" }
  | { kind: "approve"; discardFeedback: boolean };

export function resolvePlanDecisionAction(id: DecisionActionId): PlanDecisionRoute {
  switch (id) {
    case "primary":
      return { kind: "primary" };
    case "note-with-approval":
      return { kind: "note", route: "approve" };
    case "request-changes":
    case "note-with-feedback":
      return { kind: "note", route: "deny" };
    case "approve-with-notes":
      return { kind: "approve", discardFeedback: false };
    case "discard-and-finish":
      return { kind: "approve", discardFeedback: true };
  }
}
