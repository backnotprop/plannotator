export interface PiAnnotateDecision {
	feedback: string;
	exit?: boolean;
	approved?: boolean;
	selectedMessageId?: string;
	feedbackScope?: "message" | "messages";
	/** The editor's Done with nothing to send: `feedback` still carries the
	 *  legacy zero-state sentence, but there is nothing for the agent. */
	nothingToSend?: boolean;
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
	// A Done with nothing to send closes quietly ("Annotation closed (no
	// feedback)."), like empty feedback: no follow-up turn.
	const feedback = result.nothingToSend === true ? "" : result.feedback;
	return {
		feedback: feedback || null,
		notification: null,
		promptKind: feedback ? "feedback" : null,
	};
}
