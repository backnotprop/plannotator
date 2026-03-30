import { describe, test, expect } from "bun:test";
import { planDenyFeedback, planApproveFeedback, DECISIONS_LOG_NOTE } from "./feedback-templates";

describe("feedback-templates", () => {
  /**
   * The whole point of this module: all three integrations (hook, opencode, pi)
   * produce identical output except for the tool name. If this test fails,
   * the templates have diverged — which is what we're trying to prevent.
   */
  test("plan deny is identical across integrations (modulo tool name)", () => {
    const normalize = (s: string) =>
      s.replace(/ExitPlanMode|submit_plan|exit_plan_mode|plannotator_submit_plan/g, "TOOL");

    const feedback = "## 1. Remove auth section\n> Not needed anymore.";
    const hook = normalize(planDenyFeedback(feedback, "ExitPlanMode"));
    const opencode = normalize(planDenyFeedback(feedback, "submit_plan"));
    const pi = normalize(planDenyFeedback(feedback, "plannotator_submit_plan"));

    expect(hook).toBe(opencode);
    expect(opencode).toBe(pi);
  });

  /**
   * The deny template must embed the user's feedback verbatim — no truncation,
   * no escaping, no wrapping. The agent needs the raw annotation output.
   */
  test("plan deny preserves feedback content verbatim", () => {
    const feedback = "## 1. Change auth\n**From:**\n```\nold code\n```\n**To:**\n```\nnew code\n```";
    const result = planDenyFeedback(feedback);
    expect(result).toContain(feedback);
  });

  /**
   * Empty feedback should not produce a broken message — the agent needs
   * something actionable even if the user didn't write annotations.
   */
  test("plan deny handles empty feedback gracefully", () => {
    const result = planDenyFeedback("");
    expect(result.length).toBeGreaterThan(50);
    expect(result).toBe(result.trimEnd());
  });

  /**
   * Version history is keyed by the plan's first # heading + date.
   * If the agent renames the heading on resubmission, the version chain breaks
   * and the user loses diffs (#296). The deny template must instruct the agent
   * to preserve the title.
   */
  test("plan deny instructs agent to preserve plan title", () => {
    const result = planDenyFeedback("feedback");
    expect(result.toLowerCase()).toContain("title");
    expect(result.toLowerCase()).toContain("heading");
  });

  test("plan deny can include a plan file hint for file-based integrations", () => {
    const result = planDenyFeedback("feedback", "plannotator_submit_plan", {
      planFilePath: "plans/auth.md",
    });

    expect(result).toContain("plans/auth.md");
    expect(result).toContain("edit this file");
    expect(result).toContain("plannotator_submit_plan");
  });

});

describe("context anchoring", () => {
  /**
   * On denial, the agent must be instructed to maintain a Decisions Log
   * so that rejected approaches are documented and not re-proposed.
   */
  test("plan deny includes context anchoring instructions", () => {
    const result = planDenyFeedback("some feedback");
    expect(result).toContain("Decisions Log");
    expect(result).toContain("Rejected:");
    expect(result).toContain("cross-session memory");
  });

  /**
   * On approval, the agent must be reminded to reference the Decisions Log
   * during implementation — closing the context anchoring loop.
   */
  test("plan approve includes Decisions Log reminder", () => {
    const result = planApproveFeedback();
    expect(result).toContain("Plan approved");
    expect(result).toContain("Decisions Log");
  });

  /**
   * Approval with notes must signal "with notes" in the header so the
   * agent knows content follows, and include both the notes and the
   * Decisions Log reminder.
   */
  test("plan approve with notes includes both notes and Decisions Log reminder", () => {
    const result = planApproveFeedback("Use the adapter pattern here.");
    expect(result).toContain("Plan approved with notes!");
    expect(result).toContain("Implementation Notes");
    expect(result).toContain("Use the adapter pattern here.");
    expect(result).toContain("Decisions Log");
  });

  /**
   * Approval without notes should NOT say "with notes".
   */
  test("plan approve without notes does not include 'with notes' in header", () => {
    const result = planApproveFeedback();
    expect(result).toContain("Plan approved!");
    expect(result).not.toContain("with notes");
  });

  /**
   * DECISIONS_LOG_NOTE is exported as a named constant so Pi and other
   * integrations that compose their own approval messages can include it
   * without duplicating the text.
   */
  test("DECISIONS_LOG_NOTE is a non-empty string containing 'Decisions Log'", () => {
    expect(typeof DECISIONS_LOG_NOTE).toBe("string");
    expect(DECISIONS_LOG_NOTE.length).toBeGreaterThan(0);
    expect(DECISIONS_LOG_NOTE).toContain("Decisions Log");
  });

  /**
   * Approval with saved path must surface the file path.
   */
  test("plan approve with savedPath includes the path", () => {
    const result = planApproveFeedback(undefined, "/tmp/plans/auth.md");
    expect(result).toContain("/tmp/plans/auth.md");
  });
});
