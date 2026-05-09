import { describe, expect, test } from "bun:test";
import { mergePromptConfig, type PromptRuntime } from "./config";
import {
  DEFAULT_REVIEW_APPROVED_PROMPT,
  DEFAULT_PLAN_DENIED_PROMPT,
  DEFAULT_PLAN_APPROVED_PROMPT,
  DEFAULT_PLAN_APPROVED_WITH_NOTES_PROMPT,
  DEFAULT_PLAN_AUTO_APPROVED_PROMPT,
  DEFAULT_ANNOTATE_FILE_FEEDBACK_PROMPT,
  DEFAULT_ANNOTATE_MESSAGE_FEEDBACK_PROMPT,
  DEFAULT_ANNOTATE_APPROVED_PROMPT,
  DEFAULT_REVIEW_DENIED_SUFFIX,
  getConfiguredPrompt,
  getReviewApprovedPrompt,
  getPlanDeniedPrompt,
  getPlanApprovedPrompt,
  getPlanApprovedWithNotesPrompt,
  getPlanAutoApprovedPrompt,
  getAnnotateFileFeedbackPrompt,
  getAnnotateMessageFeedbackPrompt,
  getAnnotateApprovedPrompt,
  getReviewDeniedSuffix,
  resolveTemplate,
  getPlanToolName,
  buildPlanFileRule,
} from "./prompts";
import { planDenyFeedback } from "./feedback-templates";

// ─── A1. Template engine ─────────────────────────────────────────────────────

describe("resolveTemplate", () => {
  test("replaces known variables", () => {
    expect(resolveTemplate("Hello {{name}}", { name: "world" }))
      .toBe("Hello world");
  });

  test("leaves unknown {{variables}} as-is", () => {
    expect(resolveTemplate("Hello {{unknown}}", {}))
      .toBe("Hello {{unknown}}");
  });

  test("handles empty vars object", () => {
    expect(resolveTemplate("no vars here", {}))
      .toBe("no vars here");
  });

  test("handles undefined values in vars (leaves placeholder)", () => {
    expect(resolveTemplate("Hello {{name}}", { name: undefined }))
      .toBe("Hello {{name}}");
  });

  test("handles template with no variables", () => {
    expect(resolveTemplate("static text", { name: "ignored" }))
      .toBe("static text");
  });

  test("handles adjacent and repeated variables", () => {
    expect(resolveTemplate("{{a}}{{b}} and {{a}}", { a: "X", b: "Y" }))
      .toBe("XY and X");
  });
});

// ─── A2. Plan denied ─────────────────────────────────────────────────────────

describe("getPlanDeniedPrompt", () => {
  test("falls back to built-in default when no config", () => {
    const result = getPlanDeniedPrompt("claude-code", {}, {
      toolName: "ExitPlanMode",
      planFileRule: "",
      feedback: "Fix the auth section",
    });
    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
    expect(result).toContain("Fix the auth section");
    expect(result).toContain("ExitPlanMode");
  });

  test("uses generic plan.denied config override", () => {
    const result = getPlanDeniedPrompt("claude-code", {
      prompts: { plan: { denied: "REJECTED.\n\n{{feedback}}" } },
    }, { feedback: "Fix it" });
    expect(result).toBe("REJECTED.\n\nFix it");
    expect(result).not.toContain("YOUR PLAN WAS NOT APPROVED");
  });

  test("runtime-specific override wins over generic", () => {
    const result = getPlanDeniedPrompt("opencode", {
      prompts: {
        plan: {
          denied: "Generic denial: {{feedback}}",
          runtimes: { opencode: { denied: "OC denial: {{feedback}}" } },
        },
      },
    }, { feedback: "nope" });
    expect(result).toBe("OC denial: nope");
  });

  test("interpolates {{toolName}}, {{feedback}}, {{planFileRule}}", () => {
    const result = getPlanDeniedPrompt(null, {}, {
      toolName: "submit_plan",
      feedback: "user feedback here",
      planFileRule: "- Saved at: plan.md\n",
    });
    expect(result).toContain("submit_plan");
    expect(result).toContain("user feedback here");
    expect(result).toContain("Saved at: plan.md");
  });

  test("blank config falls through to default", () => {
    const result = getPlanDeniedPrompt("opencode", {
      prompts: { plan: { denied: "   ", runtimes: { opencode: { denied: "" } } } },
    }, { toolName: "submit_plan", planFileRule: "", feedback: "fb" });
    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
  });

  test("default template preserves plan title instruction (regression #296)", () => {
    const result = getPlanDeniedPrompt(null, {}, {
      toolName: "ExitPlanMode", planFileRule: "", feedback: "fb",
    });
    expect(result.toLowerCase()).toContain("title");
    expect(result.toLowerCase()).toContain("heading");
  });

  test("includes plan file rule when planFileRule var is populated", () => {
    const result = getPlanDeniedPrompt(null, {}, {
      toolName: "ExitPlanMode",
      planFileRule: buildPlanFileRule("ExitPlanMode", "plans/auth.md"),
      feedback: "fb",
    });
    expect(result).toContain("plans/auth.md");
    expect(result).toContain("edit this file");
  });

  test("omits plan file rule when planFileRule is empty", () => {
    const result = getPlanDeniedPrompt(null, {}, {
      toolName: "ExitPlanMode", planFileRule: "", feedback: "fb",
    });
    expect(result).not.toContain("saved at");
  });

  test("output is identical across runtimes modulo toolName (parity)", () => {
    const normalize = (s: string) =>
      s.replace(/ExitPlanMode|submit_plan|exit_plan_mode|plannotator_submit_plan/g, "TOOL");

    const make = (rt: PromptRuntime) => normalize(getPlanDeniedPrompt(rt, {}, {
      toolName: getPlanToolName(rt),
      planFileRule: "",
      feedback: "## Fix auth",
    }));

    const cc = make("claude-code");
    expect(make("opencode")).toBe(cc);
    expect(make("pi")).toBe(cc);
    expect(make("copilot-cli")).toBe(cc);
    expect(make("gemini-cli")).toBe(cc);
  });
});

// ─── A3. Plan approved ───────────────────────────────────────────────────────

describe("getPlanApprovedPrompt", () => {
  test("falls back to runtime built-in default (pi vs opencode differ)", () => {
    const pi = getPlanApprovedPrompt("pi", {}, { planFilePath: "plan.md", doneMsg: "" });
    const oc = getPlanApprovedPrompt("opencode", {}, { doneMsg: "" });
    expect(pi).toContain("full tool access");
    expect(oc).not.toContain("full tool access");
    expect(oc).toContain("Plan approved!");
  });

  test("uses configured prompt with variable interpolation", () => {
    const result = getPlanApprovedPrompt("pi", {
      prompts: { plan: { approved: "Go ahead with {{planFilePath}}." } },
    }, { planFilePath: "my-plan.md" });
    expect(result).toBe("Go ahead with my-plan.md.");
  });

  test("runtime config wins over generic config wins over runtime default", () => {
    const result = getPlanApprovedPrompt("opencode", {
      prompts: {
        plan: {
          approved: "Generic approved",
          runtimes: { opencode: { approved: "OC approved" } },
        },
      },
    });
    expect(result).toBe("OC approved");
  });

  test("interpolates {{planFilePath}} and {{doneMsg}}", () => {
    const result = getPlanApprovedPrompt("pi", {}, {
      planFilePath: "plans/auth.md",
      doneMsg: "Check each step.",
    });
    expect(result).toContain("plans/auth.md");
    expect(result).toContain("Check each step.");
  });
});

describe("getPlanApprovedWithNotesPrompt", () => {
  test("includes Implementation Notes section in default", () => {
    const result = getPlanApprovedWithNotesPrompt("pi", {}, {
      planFilePath: "p.md", doneMsg: "", feedback: "Watch the edge case",
    });
    expect(result).toContain("## Implementation Notes");
    expect(result).toContain("Watch the edge case");
  });

  test("opencode runtime default omits planFilePath and tool access language", () => {
    const result = getPlanApprovedWithNotesPrompt("opencode", {}, {
      doneMsg: "Saved to: /tmp/plan.md",
      feedback: "Watch the edge case",
    });
    expect(result).toContain("Plan approved with notes!");
    expect(result).toContain("Watch the edge case");
    expect(result).toContain("Saved to: /tmp/plan.md");
    expect(result).not.toContain("full tool access");
    expect(result).not.toContain("Execute the plan in");
    // doneMsg is on its own line after the header (matching old behavior)
    expect(result).toContain("notes!\nSaved to:");
  });

  test("uses configured override when present", () => {
    const result = getPlanApprovedWithNotesPrompt("pi", {
      prompts: { plan: { approvedWithNotes: "Approved. Notes: {{feedback}}" } },
    }, { feedback: "be careful" });
    expect(result).toBe("Approved. Notes: be careful");
  });
});

describe("getPlanAutoApprovedPrompt", () => {
  test("returns default auto-approved message", () => {
    expect(getPlanAutoApprovedPrompt("pi", {})).toContain("auto-approved");
  });

  test("uses configured override", () => {
    expect(getPlanAutoApprovedPrompt("pi", {
      prompts: { plan: { autoApproved: "Auto OK" } },
    })).toBe("Auto OK");
  });
});

// ─── A4. Annotation feedback ─────────────────────────────────────────────────

describe("getAnnotateFileFeedbackPrompt", () => {
  test("includes file header and path in default", () => {
    const result = getAnnotateFileFeedbackPrompt("opencode", {}, {
      fileHeader: "File", filePath: "/src/app.ts", feedback: "Fix line 5",
    });
    expect(result).toContain("File: /src/app.ts");
    expect(result).toContain("Fix line 5");
    expect(result).toContain("Please address");
  });

  test("handles folder header variant", () => {
    const result = getAnnotateFileFeedbackPrompt("pi", {}, {
      fileHeader: "Folder", filePath: "/src/", feedback: "Check all files",
    });
    expect(result).toContain("Folder: /src/");
  });

  test("uses configured override", () => {
    const result = getAnnotateFileFeedbackPrompt("opencode", {
      prompts: { annotate: { fileFeedback: "Review {{filePath}}: {{feedback}}" } },
    }, { filePath: "x.ts", feedback: "fix it" });
    expect(result).toBe("Review x.ts: fix it");
  });

  test("runtime-specific override wins over generic", () => {
    const result = getAnnotateFileFeedbackPrompt("pi", {
      prompts: {
        annotate: {
          fileFeedback: "Generic: {{feedback}}",
          runtimes: { pi: { fileFeedback: "Pi: {{feedback}}" } },
        },
      },
    }, { feedback: "note" });
    expect(result).toBe("Pi: note");
  });
});

describe("getAnnotateMessageFeedbackPrompt", () => {
  test("includes feedback in default template", () => {
    const result = getAnnotateMessageFeedbackPrompt("pi", {}, { feedback: "Wrong output" });
    expect(result).toContain("Message Annotations");
    expect(result).toContain("Wrong output");
  });

  test("uses configured override", () => {
    const result = getAnnotateMessageFeedbackPrompt("pi", {
      prompts: { annotate: { messageFeedback: "Notes: {{feedback}}" } },
    }, { feedback: "fix" });
    expect(result).toBe("Notes: fix");
  });
});

describe("getAnnotateApprovedPrompt", () => {
  test("returns default approved message", () => {
    expect(getAnnotateApprovedPrompt("claude-code", {})).toBe("The user approved.");
  });

  test("uses configured override", () => {
    expect(getAnnotateApprovedPrompt("claude-code", {
      prompts: { annotate: { approved: "Approved!" } },
    })).toBe("Approved!");
  });
});

// ─── A4b. Review denied suffix ───────────────────────────────────────────────

describe("getReviewDeniedSuffix", () => {
  test("returns default suffix for claude-code", () => {
    const result = getReviewDeniedSuffix("claude-code", {});
    expect(result).toContain("identified issues");
  });

  test("opencode and pi use softer runtime default", () => {
    const oc = getReviewDeniedSuffix("opencode", {});
    const pi = getReviewDeniedSuffix("pi", {});
    expect(oc).toBe("\n\nPlease address this feedback.");
    expect(pi).toBe("\n\nPlease address this feedback.");
  });

  test("uses configured override", () => {
    expect(getReviewDeniedSuffix("claude-code", {
      prompts: { review: { denied: "\nFix everything." } },
    })).toBe("\nFix everything.");
  });
});

// ─── A5. Backward compatibility ──────────────────────────────────────────────

describe("backward compatibility", () => {
  test("planDenyFeedback() produces same output via pipeline as before", () => {
    const feedback = "## Fix auth\n> Remove the old token.";
    const direct = getPlanDeniedPrompt(null, undefined, {
      toolName: "ExitPlanMode",
      planFileRule: "",
      feedback,
    });
    expect(planDenyFeedback(feedback, "ExitPlanMode")).toBe(direct);
  });

  test("planDenyFeedback() with planFilePath produces same output", () => {
    const direct = getPlanDeniedPrompt(null, undefined, {
      toolName: "plannotator_submit_plan",
      planFileRule: buildPlanFileRule("plannotator_submit_plan", "plans/auth.md"),
      feedback: "Fix it",
    });
    expect(planDenyFeedback("Fix it", "plannotator_submit_plan", {
      planFilePath: "plans/auth.md",
    })).toBe(direct);
  });
});

// ─── A6. Config merge (expanded) ─────────────────────────────────────────────

describe("mergePromptConfig (expanded)", () => {
  test("merges plan section alongside existing review section", () => {
    const merged = mergePromptConfig(
      { review: { approved: "R" } },
      { plan: { denied: "D" } },
    );
    expect(merged?.review?.approved).toBe("R");
    expect(merged?.plan?.denied).toBe("D");
  });

  test("merges annotate section", () => {
    const merged = mergePromptConfig(
      { annotate: { approved: "A" } },
      { annotate: { fileFeedback: "F" } },
    );
    expect(merged?.annotate?.approved).toBe("A");
    expect(merged?.annotate?.fileFeedback).toBe("F");
  });

  test("deep merges runtimes within plan section", () => {
    const merged = mergePromptConfig(
      { plan: { runtimes: { pi: { denied: "Pi deny" } } } },
      { plan: { runtimes: { opencode: { denied: "OC deny" } } } },
    );
    expect(merged?.plan?.runtimes?.pi?.denied).toBe("Pi deny");
    expect(merged?.plan?.runtimes?.opencode?.denied).toBe("OC deny");
  });
});

// ─── Existing review prompt tests (preserved from PR #561) ───────────────────

describe("prompts", () => {
  test("falls back to built-in default when no config is present", () => {
    expect(getReviewApprovedPrompt("opencode", {})).toBe(DEFAULT_REVIEW_APPROVED_PROMPT);
  });

  test("uses generic configured review approval prompt", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: { review: { approved: "Commit these changes now." } },
      }),
    ).toBe("Commit these changes now.");
  });

  test("runtime-specific review approval prompt wins over generic prompt", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: {
          review: {
            approved: "Generic approval.",
            runtimes: {
              opencode: { approved: "OpenCode-specific approval." },
            },
          },
        },
      }),
    ).toBe("OpenCode-specific approval.");
  });

  test("blank prompt values fall back to the next available default", () => {
    expect(
      getReviewApprovedPrompt("opencode", {
        prompts: {
          review: {
            approved: "   ",
            runtimes: {
              opencode: { approved: "" },
            },
          },
        },
      }),
    ).toBe(DEFAULT_REVIEW_APPROVED_PROMPT);
  });

  test("generic loader resolves prompt paths with fallback", () => {
    expect(
      getConfiguredPrompt({
        section: "review",
        key: "approved",
        runtime: "pi",
        fallback: "Fallback",
        config: {
          prompts: {
            review: {
              runtimes: {
                pi: { approved: "Pi prompt" },
              },
            },
          },
        },
      }),
    ).toBe("Pi prompt");
  });

  test("mergePromptConfig keeps generic and sibling runtime prompts", () => {
    const merged = mergePromptConfig(
      {
        review: {
          approved: "Generic approval.",
          runtimes: {
            opencode: { approved: "OpenCode approval." },
          },
        },
      },
      {
        review: {
          runtimes: {
            "claude-code": { approved: "Claude approval." },
          },
        },
      },
    );

    expect(merged?.review?.approved).toBe("Generic approval.");
    expect(merged?.review?.runtimes?.opencode?.approved).toBe("OpenCode approval.");
    expect(merged?.review?.runtimes?.["claude-code"]?.approved).toBe("Claude approval.");
  });
});

// ─── Helper tests ────────────────────────────────────────────────────────────

describe("getPlanToolName", () => {
  test("returns correct tool name per runtime", () => {
    expect(getPlanToolName("claude-code")).toBe("ExitPlanMode");
    expect(getPlanToolName("opencode")).toBe("submit_plan");
    expect(getPlanToolName("copilot-cli")).toBe("exit_plan_mode");
    expect(getPlanToolName("pi")).toBe("plannotator_submit_plan");
    expect(getPlanToolName("gemini-cli")).toBe("exit_plan_mode");
  });

  test("defaults to ExitPlanMode for null/undefined", () => {
    expect(getPlanToolName(null)).toBe("ExitPlanMode");
    expect(getPlanToolName(undefined)).toBe("ExitPlanMode");
  });
});

describe("buildPlanFileRule", () => {
  test("returns empty string when no planFilePath", () => {
    expect(buildPlanFileRule("ExitPlanMode")).toBe("");
    expect(buildPlanFileRule("ExitPlanMode", undefined)).toBe("");
  });

  test("includes path and tool name when planFilePath provided", () => {
    const result = buildPlanFileRule("submit_plan", "plans/auth.md");
    expect(result).toContain("plans/auth.md");
    expect(result).toContain("submit_plan");
    expect(result).toContain("edit this file");
  });
});
