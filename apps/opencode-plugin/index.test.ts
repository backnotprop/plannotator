/**
 * Tests for the OpenCode plugin tool-helpers.
 *
 * The plugin shells out to the plannotator CLI for review/annotate/submit.
 * These tests verify the parsing, formatting, and session-prompting logic
 * by pointing PLANNOTATOR_CLI_ENTRYPOINT at a mock script that returns
 * controlled verdicts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  runPlannotatorAnnotateTool,
  runPlannotatorReviewTool,
  runPlannotatorSubmitCli,
} from "./tool-helpers";
import {
  cleanupTempDirs,
  createToolContext,
  withMockCli,
} from "./test-helpers";

afterEach(async () => {
  await cleanupTempDirs();
});

// ---------------------------------------------------------------------------
// runPlannotatorSubmitCli
// ---------------------------------------------------------------------------

describe("runPlannotatorSubmitCli", () => {
  test("parses an approved verdict from submit", async () => {
    await withMockCli(
      {
        approved: true,
        mode: "plan",
        feedback: "LGTM",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorSubmitCli(
          { plan: "do the thing", commit_message: "feat: do the thing" },
          { client, directory },
          undefined,
        );
        expect(result.approved).toBe(true);
        expect(result.mode).toBe("plan");
        expect(result.feedback).toBe("LGTM");
      },
    );
  });

  test("parses a rejected verdict with feedback from submit", async () => {
    await withMockCli(
      {
        approved: false,
        mode: "plan",
        feedback: "Needs more detail",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorSubmitCli(
          { plan: "vague plan", commit_message: "wip" },
          { client, directory },
          undefined,
        );
        expect(result.approved).toBe(false);
        expect(result.feedback).toBe("Needs more detail");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// runPlannotatorReviewTool
// ---------------------------------------------------------------------------

describe("runPlannotatorReviewTool", () => {
  test("returns feedback message when review has notes", async () => {
    await withMockCli(
      {
        approved: true,
        mode: "review",
        feedback: "Looks good, minor style nit.",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory },
        );
        expect(result).toContain("Code review completed with notes");
        expect(result).toContain("minor style nit");
      },
    );
  });

  test("returns rejection message when review requests changes", async () => {
    await withMockCli(
      {
        approved: false,
        mode: "review",
        feedback: "Please fix the error handling.",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "staged" },
          createToolContext("review-session"),
          { client, directory },
        );
        expect(result).toContain("Code review feedback received");
        expect(result).toContain("Please fix the error handling");
      },
    );
  });

  test("returns cancelled message when user cancels", async () => {
    await withMockCli(
      {
        approved: false,
        cancelled: true as boolean | undefined,
        mode: "review",
      },
      async ({ client, directory, prompts }) => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("cancelled by user");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].path.id).toBe("review-session");
      },
    );
  });

  test("returns no-requested-changes message when feedback is empty", async () => {
    await withMockCli(
      {
        approved: true,
        mode: "review",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "last-commit" },
          createToolContext("review-session"),
          { client, directory },
        );
        expect(result).toContain("no requested changes");
      },
    );
  });

  test("prompts session with agent switch when review approves with agentSwitch", async () => {
    await withMockCli(
      {
        approved: false,
        mode: "review",
        feedback: "Please fix the logic.",
        agentSwitch: "build",
      },
      async ({ client, directory, prompts }) => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("Code review feedback received");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].body.agent).toBe("build");
        expect(prompts[0].path.id).toBe("review-session");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// runPlannotatorAnnotateTool
// ---------------------------------------------------------------------------

describe("runPlannotatorAnnotateTool", () => {
  test("returns feedback message when annotation has changes", async () => {
    await withMockCli(
      {
        approved: true,
        mode: "annotate",
        feedback: "Please tighten the introduction.",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "docs/design.md" },
          createToolContext("annotate-session"),
          { client, directory },
        );
        expect(result).toContain("Annotation feedback received for docs/design.md");
        expect(result).toContain("Please tighten the introduction.");
      },
    );
  });

  test("returns cancelled message when user cancels annotation", async () => {
    await withMockCli(
      {
        approved: false,
        cancelled: true as boolean | undefined,
        mode: "annotate",
      },
      async ({ client, directory, prompts }) => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "README.md" },
          createToolContext("annotate-session"),
          { client, directory },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("cancelled by user");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].path.id).toBe("annotate-session");
      },
    );
  });

  test("returns no-requested-changes message when annotation has no feedback", async () => {
    await withMockCli(
      {
        approved: true,
        mode: "annotate",
      },
      async ({ client, directory }) => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "notes/todo.md" },
          createToolContext("annotate-session"),
          { client, directory },
        );
        expect(result).toContain("no requested changes");
      },
    );
  });

  test("prompts session with feedback message when annotation has changes and promptSessionOnCompletion is true", async () => {
    await withMockCli(
      {
        approved: false,
        mode: "annotate",
        feedback: "Rewrite section 2.",
      },
      async ({ client, directory, prompts }) => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "docs/api.md" },
          createToolContext("annotate-session-2"),
          { client, directory },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("Annotation feedback received for docs/api.md");
        expect(result).toContain("Rewrite section 2.");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].path.id).toBe("annotate-session-2");
        expect(prompts[0].body.parts[0].text).toContain("Markdown Annotations");
        expect(prompts[0].body.parts[0].text).toContain("docs/api.md");
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Slash command smoke test
// ---------------------------------------------------------------------------

describe("plannotator annotate slash command", () => {
  test("passes the plain-text description through to the agent tool prompt", async () => {
    const command = await Bun.file(
      join(import.meta.dir, "commands", "plannotator-annotate.md"),
    ).text();
    expect(command.length).toBeGreaterThan(0);
    expect(command).toContain("plannotator_annotate");
  });
});
