export interface PiReviewDecision {
	approved: boolean;
	feedback?: string;
	exit?: boolean;
	platform?: boolean;
}

export type ClassifiedReviewOutcome =
	| { kind: "closed" }
	| { kind: "approved" }
	| { kind: "no-feedback" }
	| { kind: "feedback"; appendDeniedSuffix: boolean };

export function classifyReviewOutcome(result: PiReviewDecision): ClassifiedReviewOutcome {
	if (result.exit) return { kind: "closed" };
	if (result.approved) return { kind: "approved" };
	if (!result.feedback) return { kind: "no-feedback" };
	return { kind: "feedback", appendDeniedSuffix: result.platform !== true };
}
