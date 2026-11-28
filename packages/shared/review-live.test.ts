import { describe, expect, test } from "bun:test";
import { reviewLiveSessionOf, reviewLiveTargetOf, reviewLiveTargetOfOpenCode } from "./review-live";

describe("who opened the review, as each host says it", () => {
  test("Claude Code's session tag names the session; anything else names none", () => {
    expect(reviewLiveTargetOf("claude-code:2f0c9a1e-7b")).toEqual({ host: "claude-code", session: "2f0c9a1e-7b" });
    for (const tag of [undefined, "", "claude-code", ":x", "claude-code:"]) expect(reviewLiveTargetOf(tag)).toBeNull();
  });

  test("OpenCode's inboxSession is its session; an older plugin sends none and a strange value is dropped", () => {
    expect(reviewLiveTargetOfOpenCode("ses_7d21abc")).toEqual({ host: "opencode", session: "ses_7d21abc" });
    for (const value of [undefined, null, 42, "", "a b", "x".repeat(201)]) expect(reviewLiveTargetOfOpenCode(value)).toBeNull();
  });

  test("a review the Inbox opened names its thread and key; one an agent opened names none", () => {
    expect(reviewLiveSessionOf({ PLANNOTATOR_REVIEW_LIVE_THREAD: "msg_01ABC", PLANNOTATOR_REVIEW_LIVE_KEY: "branch:fix/x" })).toEqual({ thread: "msg_01ABC", key: "branch:fix/x", title: "branch:fix/x" });
    expect(reviewLiveSessionOf({})).toBeNull();
    expect(reviewLiveSessionOf({ PLANNOTATOR_REVIEW_LIVE_THREAD: "../x", PLANNOTATOR_REVIEW_LIVE_KEY: "k" })).toBeNull();
  });
});
