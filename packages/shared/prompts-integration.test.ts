/**
 * Integration tests for the prompt pipeline.
 *
 * Each test writes a real ~/.plannotator/config.json (in a temp HOME),
 * then calls prompt functions WITHOUT passing a config parameter —
 * forcing loadConfig() to read from disk. This proves the full path:
 *   config.json on disk → loadConfig() → getConfiguredPrompt() → output
 *
 * Uses the same subprocess isolation pattern as improvement-hooks.test.ts.
 *
 * Run: bun test packages/shared/prompts-integration.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const TEST_HOME = join(tmpdir(), `prompts-integration-test-${Date.now()}`);
const CONFIG_DIR = join(TEST_HOME, ".plannotator");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PROJECT_ROOT = join(import.meta.dir, "../..");

function writeConfig(config: Record<string, unknown>) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function cleanTestHome() {
  if (existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
}

async function runScript(script: string): Promise<string> {
  const proc = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, HOME: TEST_HOME },
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Subprocess failed (exit ${exitCode}): ${stderr}`);
  }

  return stdout.trim();
}

describe("prompts integration (config from disk)", () => {
  beforeEach(() => {
    cleanTestHome();
    mkdirSync(CONFIG_DIR, { recursive: true });
  });
  afterEach(cleanTestHome);

  // ── Plan denied ──────────────────────────────────────────────────────

  test("plan denied reads generic override from config.json", async () => {
    writeConfig({
      prompts: {
        plan: {
          denied: "NOPE.\n\n{{feedback}}",
        },
      },
    });

    const result = await runScript(`
      import { getPlanDeniedPrompt } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: "ExitPlanMode",
        planFileRule: "",
        feedback: "Fix the auth",
      }));
    `);

    expect(result).toBe("NOPE.\n\nFix the auth");
    expect(result).not.toContain("YOUR PLAN WAS NOT APPROVED");
  });

  test("plan denied reads runtime-specific override from config.json", async () => {
    writeConfig({
      prompts: {
        plan: {
          denied: "Generic: {{feedback}}",
          runtimes: {
            opencode: { denied: "OpenCode: {{feedback}}" },
          },
        },
      },
    });

    const oc = await runScript(`
      import { getPlanDeniedPrompt, getPlanToolName } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("opencode", undefined, {
        toolName: getPlanToolName("opencode"),
        planFileRule: "",
        feedback: "Fix it",
      }));
    `);
    expect(oc).toBe("OpenCode: Fix it");

    const cc = await runScript(`
      import { getPlanDeniedPrompt, getPlanToolName } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: getPlanToolName("claude-code"),
        planFileRule: "",
        feedback: "Fix it",
      }));
    `);
    expect(cc).toBe("Generic: Fix it");
  });

  test("plan denied falls back to hardcoded default when config.json missing", async () => {
    // No config file written — CONFIG_DIR exists but no config.json
    rmSync(CONFIG_PATH, { force: true });

    const result = await runScript(`
      import { getPlanDeniedPrompt } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: "ExitPlanMode",
        planFileRule: "",
        feedback: "Some feedback",
      }));
    `);

    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
    expect(result).toContain("Some feedback");
  });

  test("plan denied falls through blank config values to default", async () => {
    writeConfig({
      prompts: {
        plan: {
          denied: "   ",
          runtimes: { "claude-code": { denied: "" } },
        },
      },
    });

    const result = await runScript(`
      import { getPlanDeniedPrompt } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: "ExitPlanMode",
        planFileRule: "",
        feedback: "fb",
      }));
    `);

    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
  });

  // ── Plan approved ────────────────────────────────────────────────────

  test("plan approved reads override from config.json", async () => {
    writeConfig({
      prompts: {
        plan: {
          approved: "Go build it.",
        },
      },
    });

    const result = await runScript(`
      import { getPlanApprovedPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedPrompt("pi"));
    `);

    expect(result).toBe("Go build it.");
    expect(result).not.toContain("full tool access");
  });

  test("plan approved uses runtime built-in default when no config", async () => {
    // No config — opencode should get its built-in "Plan approved!{{doneMsg}}"
    const oc = await runScript(`
      import { getPlanApprovedPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedPrompt("opencode", undefined, { doneMsg: " Done." }));
    `);
    expect(oc).toBe("Plan approved! Done.");

    // Pi should get the verbose default
    const pi = await runScript(`
      import { getPlanApprovedPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedPrompt("pi", undefined, {
        planFilePath: "plan.md", doneMsg: "",
      }));
    `);
    expect(pi).toContain("full tool access");
    expect(pi).toContain("plan.md");
  });

  // ── Plan approved with notes ─────────────────────────────────────────

  test("plan approved with notes reads override from config.json", async () => {
    writeConfig({
      prompts: {
        plan: {
          approvedWithNotes: "Approved. User says: {{feedback}}",
        },
      },
    });

    const result = await runScript(`
      import { getPlanApprovedWithNotesPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedWithNotesPrompt("pi", undefined, {
        feedback: "Watch the edge case",
      }));
    `);

    expect(result).toBe("Approved. User says: Watch the edge case");
  });

  test("plan approved with notes uses opencode runtime default when no config", async () => {
    const result = await runScript(`
      import { getPlanApprovedWithNotesPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedWithNotesPrompt("opencode", undefined, {
        doneMsg: "",
        feedback: "Be careful",
      }));
    `);

    expect(result).toContain("Plan approved with notes!");
    expect(result).toContain("Be careful");
    expect(result).not.toContain("full tool access");
    expect(result).not.toContain("Execute the plan in");
  });

  // ── Plan auto-approved ───────────────────────────────────────────────

  test("plan auto-approved reads override from config.json", async () => {
    writeConfig({
      prompts: { plan: { autoApproved: "Auto-OK. Proceed." } },
    });

    const result = await runScript(`
      import { getPlanAutoApprovedPrompt } from "./packages/shared/prompts";
      console.log(getPlanAutoApprovedPrompt("pi"));
    `);

    expect(result).toBe("Auto-OK. Proceed.");
  });

  // ── Annotate file feedback ───────────────────────────────────────────

  test("annotate file feedback reads override from config.json", async () => {
    writeConfig({
      prompts: {
        annotate: {
          fileFeedback: "# Notes\n\n{{filePath}}: {{feedback}}",
        },
      },
    });

    const result = await runScript(`
      import { getAnnotateFileFeedbackPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateFileFeedbackPrompt("opencode", undefined, {
        fileHeader: "File",
        filePath: "src/app.ts",
        feedback: "Fix line 10",
      }));
    `);

    expect(result).toBe("# Notes\n\nsrc/app.ts: Fix line 10");
  });

  test("annotate file feedback reads runtime-specific override", async () => {
    writeConfig({
      prompts: {
        annotate: {
          fileFeedback: "Generic: {{feedback}}",
          runtimes: {
            pi: { fileFeedback: "Pi: {{filePath}} — {{feedback}}" },
          },
        },
      },
    });

    const pi = await runScript(`
      import { getAnnotateFileFeedbackPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateFileFeedbackPrompt("pi", undefined, {
        fileHeader: "File", filePath: "x.ts", feedback: "fix",
      }));
    `);
    expect(pi).toBe("Pi: x.ts — fix");

    const oc = await runScript(`
      import { getAnnotateFileFeedbackPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateFileFeedbackPrompt("opencode", undefined, {
        fileHeader: "File", filePath: "x.ts", feedback: "fix",
      }));
    `);
    expect(oc).toBe("Generic: fix");
  });

  // ── Annotate message feedback ────────────────────────────────────────

  test("annotate message feedback reads override from config.json", async () => {
    writeConfig({
      prompts: {
        annotate: {
          messageFeedback: "Message review:\n\n{{feedback}}",
        },
      },
    });

    const result = await runScript(`
      import { getAnnotateMessageFeedbackPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateMessageFeedbackPrompt("pi", undefined, {
        feedback: "Wrong output",
      }));
    `);

    expect(result).toBe("Message review:\n\nWrong output");
  });

  // ── Annotate approved ────────────────────────────────────────────────

  test("annotate approved reads override from config.json", async () => {
    writeConfig({
      prompts: { annotate: { approved: "LGTM" } },
    });

    const result = await runScript(`
      import { getAnnotateApprovedPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateApprovedPrompt("claude-code"));
    `);

    expect(result).toBe("LGTM");
  });

  // ── Review denied suffix ─────────────────────────────────────────────

  test("review denied suffix reads override from config.json", async () => {
    writeConfig({
      prompts: { review: { denied: "\n\nFix everything now." } },
    });

    const result = await runScript(`
      import { getReviewDeniedSuffix } from "./packages/shared/prompts";
      console.log(JSON.stringify(getReviewDeniedSuffix("claude-code")));
    `);

    expect(JSON.parse(result)).toBe("\n\nFix everything now.");
  });

  // ── Cross-section isolation ──────────────────────────────────────────

  test("config sections don't bleed into each other", async () => {
    writeConfig({
      prompts: {
        plan: { denied: "Custom plan denial: {{feedback}}" },
        annotate: { approved: "Custom annotate approved" },
      },
    });

    // Plan denied should use custom
    const planDenied = await runScript(`
      import { getPlanDeniedPrompt } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: "ExitPlanMode", planFileRule: "", feedback: "fb",
      }));
    `);
    expect(planDenied).toBe("Custom plan denial: fb");

    // Annotate approved should use custom
    const annotateApproved = await runScript(`
      import { getAnnotateApprovedPrompt } from "./packages/shared/prompts";
      console.log(getAnnotateApprovedPrompt("claude-code"));
    `);
    expect(annotateApproved).toBe("Custom annotate approved");

    // Plan approved should still be the default (not set in config)
    const planApproved = await runScript(`
      import { getPlanApprovedPrompt } from "./packages/shared/prompts";
      console.log(getPlanApprovedPrompt("pi", undefined, {
        planFilePath: "p.md", doneMsg: "",
      }));
    `);
    expect(planApproved).toContain("full tool access");
  });

  // ── Malformed config resilience ──────────────────────────────────────

  test("malformed config.json falls back to defaults gracefully", async () => {
    writeFileSync(CONFIG_PATH, "not valid json {{{");

    const result = await runScript(`
      import { getPlanDeniedPrompt } from "./packages/shared/prompts";
      console.log(getPlanDeniedPrompt("claude-code", undefined, {
        toolName: "ExitPlanMode", planFileRule: "", feedback: "fb",
      }));
    `);

    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
  });

  // ── planDenyFeedback is browser-safe (no Node imports) ────────────────

  test("planDenyFeedback() always uses hardcoded default (not config)", async () => {
    writeConfig({
      prompts: {
        plan: { denied: "CUSTOM.\n\n{{feedback}}" },
      },
    });

    const result = await runScript(`
      import { planDenyFeedback } from "./packages/shared/feedback-templates";
      console.log(planDenyFeedback("Fix auth", "ExitPlanMode"));
    `);

    // planDenyFeedback is self-contained — it does NOT read config.json.
    // This is intentional: it's imported by the browser SPA bundle, which
    // cannot access Node APIs. Config-aware denials use getPlanDeniedPrompt().
    expect(result).toContain("YOUR PLAN WAS NOT APPROVED");
    expect(result).toContain("Fix auth");
  });
});
