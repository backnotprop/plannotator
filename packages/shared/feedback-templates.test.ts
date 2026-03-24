import { describe, test, expect } from "bun:test";
import { planDenyFeedback } from "./feedback-templates";

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
