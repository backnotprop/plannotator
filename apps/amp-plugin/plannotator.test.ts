import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildPlannotatorEnv,
  extractTextFromThreadMessage,
  findFirstPositionalArg,
  formatAnnotationFeedback,
  getPlannotatorDataDir,
  isNoActionFeedback,
  parseAnnotateDecision,
  parseReviewTargetInput,
  resolveCwd,
  splitCommandArgs,
} from "./plannotator";

describe("Amp Plannotator plugin helpers", () => {
  test("extracts visible assistant text blocks", () => {
    const text = extractTextFromThreadMessage({
      role: "assistant",
      id: "m-1",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "First paragraph." },
        { type: "tool_use", id: "tool-1", name: "bash", input: {} },
        { type: "text", text: "Second paragraph." },
      ],
    });

    expect(text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("parses structured annotate decisions", () => {
    expect(parseAnnotateDecision('{"decision":"approved"}')).toEqual({ decision: "approved" });
    expect(parseAnnotateDecision("")).toEqual({ decision: "dismissed" });
    expect(parseAnnotateDecision("plain feedback")).toBeNull();
  });

  test("wraps actionable annotation feedback for Amp thread append", () => {
    expect(
      formatAnnotationFeedback(
        { decision: "annotated", feedback: "Comment: tighten this section." },
        { kind: "message" },
      ),
    ).toBe(
      "# Message Annotations\n\nComment: tighten this section.\n\nPlease address the annotation feedback above.",
    );
  });

  test("wraps file annotation feedback with target path", () => {
    expect(
      formatAnnotationFeedback(
        { decision: "annotated", feedback: "Comment: tighten this section." },
        { kind: "file", filePath: "docs/plan.md" },
      ),
    ).toBe(
      "# Markdown Annotations\n\nFile: docs/plan.md\n\nComment: tighten this section.\n\nPlease address the annotation feedback above.",
    );
  });

  test("detects non-action outputs", () => {
    expect(isNoActionFeedback("Review session closed without feedback.")).toBe(true);
    expect(isNoActionFeedback("Code review completed — no changes requested.")).toBe(false);
    expect(isNoActionFeedback("Please fix this bug.")).toBe(false);
  });

  test("splits review target arguments without invoking a shell", () => {
    expect(splitCommandArgs("--git https://github.com/org/repo/pull/1")).toEqual([
      "--git",
      "https://github.com/org/repo/pull/1",
    ]);
    expect(splitCommandArgs('"https://example.com/a path"')).toEqual([
      "https://example.com/a path",
    ]);
    expect(splitCommandArgs(String.raw`docs/My\ File.md --gate`)).toEqual([
      "docs/My File.md",
      "--gate",
    ]);
    expect(splitCommandArgs(String.raw`C:\Users\alice\plan.md`)).toEqual([
      String.raw`C:\Users\alice\plan.md`,
    ]);
    expect(splitCommandArgs(String.raw`"C:\Users\alice\My Plan.md"`)).toEqual([
      String.raw`C:\Users\alice\My Plan.md`,
    ]);
  });

  test("finds annotate target after flags", () => {
    expect(findFirstPositionalArg(["--no-jina", "https://example.com"])).toBe("https://example.com");
    expect(findFirstPositionalArg(["--browser", "Google Chrome", "docs/plan.md"])).toBe("docs/plan.md");
  });

  test("distinguishes canceled review target prompts from blank local reviews", () => {
    expect(parseReviewTargetInput(undefined)).toBeNull();
    expect(parseReviewTargetInput("   ")).toEqual([]);
    expect(parseReviewTargetInput("--git https://github.com/org/repo/pull/1")).toEqual([
      "--git",
      "https://github.com/org/repo/pull/1",
    ]);
  });

  test("prefers Amp command cwd over process PWD", async () => {
    const processPwd = mkdtempSync(join(tmpdir(), "plannotator-amp-process-"));
    const commandCwd = mkdtempSync(join(tmpdir(), "plannotator-amp-command-"));
    const originalPwd = process.env.PWD;
    const originalOverride = process.env.PLANNOTATOR_CWD;

    try {
      process.env.PWD = processPwd;
      delete process.env.PLANNOTATOR_CWD;

      const cwd = await resolveCwd(commandContextWithCwd(commandCwd));

      expect(cwd).toBe(commandCwd);
    } finally {
      restoreEnv("PWD", originalPwd);
      restoreEnv("PLANNOTATOR_CWD", originalOverride);
      rmSync(processPwd, { recursive: true, force: true });
      rmSync(commandCwd, { recursive: true, force: true });
    }
  });

  test("lets PLANNOTATOR_CWD override Amp command cwd", async () => {
    const explicitCwd = mkdtempSync(join(tmpdir(), "plannotator-amp-explicit-"));
    const commandCwd = mkdtempSync(join(tmpdir(), "plannotator-amp-command-"));
    const originalOverride = process.env.PLANNOTATOR_CWD;

    try {
      process.env.PLANNOTATOR_CWD = explicitCwd;

      const cwd = await resolveCwd(commandContextWithCwd(commandCwd));

      expect(cwd).toBe(explicitCwd);
    } finally {
      restoreEnv("PLANNOTATOR_CWD", originalOverride);
      rmSync(explicitCwd, { recursive: true, force: true });
      rmSync(commandCwd, { recursive: true, force: true });
    }
  });

  test("ready-file mode preserves Plannotator browser opening", () => {
    expect(buildPlannotatorEnv("/repo", "/tmp/ready.jsonl")).toEqual({
      PLANNOTATOR_ORIGIN: "amp",
      PLANNOTATOR_CWD: "/repo",
      PLANNOTATOR_READY_FILE: "/tmp/ready.jsonl",
    });
  });

  test("matches shared Plannotator data directory semantics", () => {
    const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;

    try {
      process.env.PLANNOTATOR_DATA_DIR = String.raw`~\plannotator-data`;
      expect(getPlannotatorDataDir()).toBe(join(homedir(), "plannotator-data"));

      process.env.PLANNOTATOR_DATA_DIR = "relative-plannotator-data";
      expect(getPlannotatorDataDir()).toBe(resolve("relative-plannotator-data"));
    } finally {
      restoreEnv("PLANNOTATOR_DATA_DIR", originalDataDir);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function commandContextWithCwd(cwd: string): Parameters<typeof resolveCwd>[0] {
  return {
    $: async () => ({ exitCode: 0, stdout: `${cwd}\n`, stderr: "" }),
  } as Parameters<typeof resolveCwd>[0];
}
