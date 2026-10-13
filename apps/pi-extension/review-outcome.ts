export interface PiReviewDecision {
	approved: boolean;
	feedback?: string;
	exit?: boolean;
	/** Set by the review server only for the PR-platform status post. */
	platform?: boolean;
}

export type ClassifiedReviewOutcome =
	| { kind: "closed" }
	| { kind: "approved" }
	| { kind: "no-feedback" }
	| { kind: "feedback"; appendDeniedSuffix: boolean };

/**
 * How `/plannotator-review` delivers a decision. Request-changes feedback
 * gets the verification suffix, including feedback with no code annotations
 * (PR description, PR comment and editor comments ride only in `feedback`).
 * The one exception is the platform path's status post, which the review
 * server marks `platform: true`: it only says where the review went, so it is
 * delivered verbatim. Never inferred from an empty annotation list.
 */
export function classifyReviewOutcome(result: PiReviewDecision): ClassifiedReviewOutcome {
	if (result.exit) return { kind: "closed" };
	if (result.approved) return { kind: "approved" };
	if (!result.feedback) return { kind: "no-feedback" };
	return { kind: "feedback", appendDeniedSuffix: result.platform !== true };
}
