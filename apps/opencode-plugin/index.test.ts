/**
 * Tests for the OpenCode plugin tool-helpers.
 *
 * The plugin shells out to the plannotator CLI for review/annotate/submit.
 * These tests verify the parsing, formatting, and session-prompting logic
 * by pointing PLANNOTATOR_CLI_ENTRYPOINT at a mock script that returns
 * controlled verdicts.
 */
/* eslint-disable @typescript-eslint/no-sync-functions -- test setup uses sync fs intentionally */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Bun expect() returns error-typed values */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Bun expect() returns error-typed values */
/* eslint-disable @typescript-eslint/require-await -- async test bodies with Bun expect() */
/* eslint-disable @typescript-eslint/no-floating-promises -- withEnv returns Promise<void> */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import {
  runPlannotatorAnnotateTool,
  runPlannotatorReviewTool,
  runPlannotatorSubmitCli,
  type PlannotatorCliVerdict,
} from "./tool-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createToolContext(sessionID = "session-1"): ToolContext {
  return {
    sessionID,
    messageID: "message-1",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

function createPromptCollector() {
  const prompts: Array<{
    path: { id: string };
    body: { agent?: string; noReply?: boolean; parts: Array<{ type: "text"; text: string }> };
  }> = [];
  return {
    prompts,
    client: {
      session: {
        // stub returns synchronously
        async prompt(request: typeof prompts[number]) {
          prompts.push(request);
          return {};
        },
      },
    },
  };
}

function createTempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-opencode-plugin-"));
  tempDirs.push(root);
  return root;
}

/**
 * Create a mock CLI entrypoint script that:
 * - Reads the subcommand from argv
 * - Writes a controlled verdict JSON to stdout
 * - Exits with code 0
 *
 * The verdict is determined by an env var PLANNOTATOR_MOCK_VERDICT
 * (base64-encoded JSON) so each test can control what the mock returns.
 */
function createMockCliEntrypoint(dir: string): string {
  const scriptPath = join(dir, "mock-cli.ts");
  const scriptContent = [
    "import { writeFileSync } from 'node:fs';",
    "const verdict = process.env.PLANNOTATOR_MOCK_VERDICT",
    "  ? JSON.parse(Buffer.from(process.env.PLANNOTATOR_MOCK_VERDICT, 'base64').toString('utf8'))",
    "  : { approved: true, mode: 'plan' };",
    "process.stdout.write(JSON.stringify(verdict));",
    "process.exit(0);",
  ].join("\n");
  writeFileSync(scriptPath, scriptContent);
  return scriptPath;
}

function encodeMockVerdict(verdict: PlannotatorCliVerdict): string {
  return Buffer.from(JSON.stringify(verdict)).toString("base64");
}

/** Save, set, and later restore env vars inside a test. */
function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(vars);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return fn().finally(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runPlannotatorSubmitCli
// ---------------------------------------------------------------------------

describe("runPlannotatorSubmitCli", () => {
  test("parses an approved verdict from submit", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: true,
          mode: "plan",
          feedback: "LGTM",
        }),
      },
      async () => {
        const result = await runPlannotatorSubmitCli(
          { plan: "do the thing", commit_message: "feat: do the thing" },
          { client, directory: dir },
          undefined,
        );
        expect(result.approved).toBe(true);
        expect(result.mode).toBe("plan");
        expect(result.feedback).toBe("LGTM");
      },
    );
  });

  test("parses a rejected verdict with feedback from submit", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          mode: "plan",
          feedback: "Needs more detail",
        }),
      },
      async () => {
        const result = await runPlannotatorSubmitCli(
          { plan: "vague plan", commit_message: "wip" },
          { client, directory: dir },
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
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: true,
          mode: "review",
          feedback: "Looks good, minor style nit.",
        }),
      },
      async () => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory: dir },
        );
        expect(result).toContain("Code review completed with notes");
        expect(result).toContain("minor style nit");
      },
    );
  });

  test("returns rejection message when review requests changes", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          mode: "review",
          feedback: "Please fix the error handling.",
        }),
      },
      async () => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "staged" },
          createToolContext("review-session"),
          { client, directory: dir },
        );
        expect(result).toContain("Code review feedback received");
        expect(result).toContain("Please fix the error handling");
      },
    );
  });

  test("returns cancelled message when user cancels", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client, prompts } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          cancelled: true as boolean | undefined,
          mode: "review",
        }),
      },
      async () => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory: dir },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("cancelled by user");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].path.id).toBe("review-session");
      },
    );
  });

  test("returns no-requested-changes message when feedback is empty", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: true,
          mode: "review",
        }),
      },
      async () => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "last-commit" },
          createToolContext("review-session"),
          { client, directory: dir },
        );
        expect(result).toContain("no requested changes");
      },
    );
  });

  test("prompts session with agent switch when review approves with agentSwitch", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client, prompts } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          mode: "review",
          feedback: "Please fix the logic.",
          agentSwitch: "build",
        }),
      },
      async () => {
        const result = await runPlannotatorReviewTool(
          { diff_type: "uncommitted" },
          createToolContext("review-session"),
          { client, directory: dir },
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
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: true,
          mode: "annotate",
          feedback: "Please tighten the introduction.",
        }),
      },
      async () => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "docs/design.md" },
          createToolContext("annotate-session"),
          { client, directory: dir },
        );
        expect(result).toContain("Annotation feedback received for docs/design.md");
        expect(result).toContain("Please tighten the introduction.");
      },
    );
  });

  test("returns cancelled message when user cancels annotation", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client, prompts } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          cancelled: true as boolean | undefined,
          mode: "annotate",
        }),
      },
      async () => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "README.md" },
          createToolContext("annotate-session"),
          { client, directory: dir },
          { promptSessionOnCompletion: true },
        );
        expect(result).toContain("cancelled by user");
        expect(prompts).toHaveLength(1);
        expect(prompts[0].path.id).toBe("annotate-session");
      },
    );
  });

  test("returns no-requested-changes message when annotation has no feedback", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: true,
          mode: "annotate",
        }),
      },
      async () => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "notes/todo.md" },
          createToolContext("annotate-session"),
          { client, directory: dir },
        );
        expect(result).toContain("no requested changes");
      },
    );
  });

  test("prompts session with feedback message when annotation has changes and promptSessionOnCompletion is true", async () => {
    const dir = createTempDir();
    const mockEntrypoint = createMockCliEntrypoint(dir);
    const { client, prompts } = createPromptCollector();

    await withEnv(
      {
        PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
        PLANNOTATOR_MOCK_VERDICT: encodeMockVerdict({
          approved: false,
          mode: "annotate",
          feedback: "Rewrite section 2.",
        }),
      },
      async () => {
        const result = await runPlannotatorAnnotateTool(
          { file_path: "docs/api.md" },
          createToolContext("annotate-session-2"),
          { client, directory: dir },
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