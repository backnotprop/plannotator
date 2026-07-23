import { describe, test, expect } from "bun:test";
import {
  annotateFileFeedback,
  annotateMessageFeedback,
  applyFeedbackTemplate,
  planDenyFeedback,
  wrapFeedbackForClipboard,
} from "./feedback-templates";

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

  test("annotate file feedback mirrors the runtime file prompt shape", () => {
    const result = annotateFileFeedback("Fix the intro", {
      fileHeader: "File",
      filePath: "/repo/README.md",
    });

    expect(result).toContain("# Markdown Annotations");
    expect(result).toContain("File: /repo/README.md");
    expect(result).toContain("Fix the intro");
    expect(result).toContain("Please address the annotation feedback above.");
  });

  test("annotate message feedback mirrors the runtime message prompt shape", () => {
    const result = annotateMessageFeedback("Wrong conclusion");

    expect(result).toContain("# Message Annotations");
    expect(result).toContain("Wrong conclusion");
    expect(result).toContain("Please address the annotation feedback above.");
  });

});

describe("applyFeedbackTemplate", () => {
  test("substitutes known placeholders", () => {
    const result = applyFeedbackTemplate("Review {{filePath}}: {{feedback}}", {
      filePath: "/repo/README.md",
      feedback: "Fix the intro",
    });
    expect(result).toBe("Review /repo/README.md: Fix the intro");
  });

  test("leaves unknown placeholders untouched (resolveTemplate parity)", () => {
    const result = applyFeedbackTemplate("{{feedback}} {{mystery}}", {
      feedback: "hi",
    });
    expect(result).toBe("hi {{mystery}}");
  });
});

/**
 * Clipboard copy wrapping (#1107): the Copy buttons must never wrap annotate
 * feedback with the plan-deny framing — that template falsely tells the agent
 * its plan was rejected. Copy must match what Send Feedback produces.
 */
describe("wrapFeedbackForClipboard", () => {
  test("plan-review mode keeps the plan-deny wrap (unchanged behavior)", () => {
    const result = wrapFeedbackForClipboard("Fix auth", { mode: "plan-review" });
    expect(result).toBe(planDenyFeedback("Fix auth"));
    expect(result).toContain("YOUR PLAN WAS NOT APPROVED.");
  });

  test("annotate-file without a server template uses the default annotate wrap", () => {
    const result = wrapFeedbackForClipboard("Fix the intro", {
      mode: "annotate-file",
      filePath: "/repo/README.md",
      fileHeader: "File",
    });
    expect(result).toBe(
      annotateFileFeedback("Fix the intro", { filePath: "/repo/README.md", fileHeader: "File" }),
    );
    expect(result).not.toContain("YOUR PLAN WAS NOT APPROVED.");
  });

  test("annotate-file applies the server-resolved template with substitution", () => {
    const result = wrapFeedbackForClipboard("Fix the intro", {
      mode: "annotate-file",
      template: "{{fileHeader}} {{filePath}} notes:\n\n{{feedback}}\n\nAnswer questions directly.",
      filePath: "/repo/README.md",
      fileHeader: "File",
    });
    expect(result).toBe(
      "File /repo/README.md notes:\n\nFix the intro\n\nAnswer questions directly.",
    );
  });

  test("annotate-file defaults fileHeader to File when the template needs it", () => {
    const result = wrapFeedbackForClipboard("Fix it", {
      mode: "annotate-file",
      template: "{{fileHeader}}: {{filePath}} — {{feedback}}",
      filePath: "/repo/doc.md",
    });
    expect(result).toBe("File: /repo/doc.md — Fix it");
  });

  test("annotate-message without a server template uses the default message wrap", () => {
    const result = wrapFeedbackForClipboard("Wrong conclusion", { mode: "annotate-message" });
    expect(result).toBe(annotateMessageFeedback("Wrong conclusion"));
    expect(result).not.toContain("YOUR PLAN WAS NOT APPROVED.");
  });

  test("annotate-message applies the server-resolved template with substitution", () => {
    const result = wrapFeedbackForClipboard("Wrong conclusion", {
      mode: "annotate-message",
      template: "Message review:\n\n{{feedback}}",
    });
    expect(result).toBe("Message review:\n\nWrong conclusion");
  });
});
