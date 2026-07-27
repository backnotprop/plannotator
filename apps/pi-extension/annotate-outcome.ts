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
