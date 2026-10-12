/**
 * Which copy a closed review shows. The failure: a plan review closed because
 * the person left plan mode or ran /reload tells them "Closed by the Agent",
 * blaming an agent that asked for nothing (or an agent close reads as a
 * session end).
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_CLOSED_TITLE,
  SESSION_CLOSED_TITLE,
  agentClosedSubtitle,
  closedReviewCopy,
  sessionClosedSubtitle,
} from "./agentClosed";

describe("closedReviewCopy", () => {
  test("a session end gets the session copy, with the saved-comment count", () => {
    const copy = closedReviewCopy({ unsentAnnotations: 3, by: "session" }, "file");
    expect(copy.title).toBe(SESSION_CLOSED_TITLE);
    expect(copy.subtitle).toBe(sessionClosedSubtitle(3));
    expect(copy.subtitle).toContain("3 comments");
    expect(copy.title).not.toBe(AGENT_CLOSED_TITLE);
  });

  test("an agent close, or an event without `by`, keeps the agent copy", () => {
    for (const closed of [{ unsentAnnotations: 2, by: "agent" as const }, { unsentAnnotations: 2 }]) {
      const copy = closedReviewCopy(closed, "changes");
      expect(copy.title).toBe(AGENT_CLOSED_TITLE);
      expect(copy.subtitle).toBe(agentClosedSubtitle(2, "changes"));
    }
  });

  test("with nothing unsent the session copy claims no saved comments", () => {
    expect(sessionClosedSubtitle(0)).not.toContain("saved");
  });
});
