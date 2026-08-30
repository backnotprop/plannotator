export interface PiAnnotateDecision {
	feedback: string;
	exit?: boolean;
	approved?: boolean;
	selectedMessageId?: string;
	feedbackScope?: "message" | "messages";
}

export interface ClassifiedAnnotateOutcome {
	feedback: string | null;
	notification: "approved" | "closed" | null;
	promptKind: "approved-with-notes" | "feedback" | null;
}

export function classifyAnnotateOutcome(
	result: PiAnnotateDecision,
): ClassifiedAnnotateOutcome {
	if (result.exit) {
		return { feedback: null, notification: "closed", promptKind: null };
	}
	if (result.approved) {
		return {
			feedback: result.feedback || null,
			notification: "approved",
			promptKind: result.feedback ? "approved-with-notes" : null,
		};
	}
	return {
		feedback: result.feedback || null,
		notification: null,
		promptKind: result.feedback ? "feedback" : null,
	};
}

/**
 * Whether last-message feedback should carry the annotated-response excerpt
 * (#1334). Anchoring re-sends up to 1,000 characters of the target response,
 * which is redundant when the model still holds it in context — so it is
 * gated on the config seam and on the target being possibly stale. Pure so
 * the gating is testable without an ExtensionContext.
 */
export function shouldPrependMessageAnchor(
	options: {
		feedbackScope?: "message" | "messages";
		anchoringEnabled: boolean;
		targetMayBeStale: boolean;
	},
): boolean {
	if (options.feedbackScope === "messages") return false;
	if (!options.anchoringEnabled) return false;
	return options.targetMayBeStale;
}
