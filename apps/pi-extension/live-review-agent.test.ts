import { expect, test } from "bun:test";
import { piLiveReviewAgent } from "./plannotator-browser";

test("a review Pi opens names Pi's session, so a first comment goes to it; a context without one names none", () => {
	expect(piLiveReviewAgent({ sessionManager: { getSessionId: () => "pi-0193" } })).toEqual({ host: "pi", session: "pi-0193" });
	expect(piLiveReviewAgent({})).toBeNull();
	expect(piLiveReviewAgent({ sessionManager: { getSessionId: () => "" } })).toBeNull();
});
