import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginAPI, PluginCommandContext } from "@ampcode/plugin";
import {
  buildEnv,
  buildPlannotatorEnv,
  extractTextFromThreadMessage,
  findFirstPositionalArg,
  getPlannotatorDataDir,
  getPlannotatorCommandCandidates,
  parseReviewTargetInput,
  resolveAmpWorkspaceRoot,
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
    expect(findFirstPositionalArg(["--markdown", "docs/page.html"])).toBe("docs/page.html");
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
    const originalLogFile = process.env.AMP_LOG_FILE;

    try {
      process.env.PWD = processPwd;
      delete process.env.PLANNOTATOR_CWD;
      process.env.AMP_LOG_FILE = join(processPwd, "missing-amp.log");

      const cwd = await resolveCwd(commandContextWithCwd(commandCwd));

      expect(cwd).toBe(commandCwd);
    } finally {
      restoreEnv("PWD", originalPwd);
      restoreEnv("PLANNOTATOR_CWD", originalOverride);
      restoreEnv("AMP_LOG_FILE", originalLogFile);
      rmSync(processPwd, { recursive: true, force: true });
      rmSync(commandCwd, { recursive: true, force: true });
    }
  });

  test("resolves Amp workspace root from the parent CLI log", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plannotator-amp-log-"));
    const oldWorkspace = mkdtempSync(join(tempDir, "old-workspace-"));
    const currentWorkspace = mkdtempSync(join(tempDir, "current-workspace-"));
    const logPath = join(tempDir, "cli.log");

    try {
      writeFileSync(
        logPath,
        [
          JSON.stringify({
            pid: 123,
            workspaceRoot: pathToFileURL(oldWorkspace).href,
          }),
          JSON.stringify({
            pid: 456,
            workspaceRoot: pathToFileURL(currentWorkspace).href,
          }),
        ].join("\n"),
        "utf8",
      );

      expect(resolveAmpWorkspaceRoot({ logPath, parentPid: 456 })).toBe(currentWorkspace);
      expect(resolveAmpWorkspaceRoot({ logPath, parentPid: 999 })).toBe(currentWorkspace);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("uses Amp workspace log before plugin runtime cwd", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "plannotator-amp-cwd-"));
    const workspace = mkdtempSync(join(tempDir, "workspace-"));
    const pluginCwd = mkdtempSync(join(tempDir, "plugins-"));
    const logPath = join(tempDir, "cli.log");
    const originalLogFile = process.env.AMP_LOG_FILE;
    const originalOverride = process.env.PLANNOTATOR_CWD;

    try {
      process.env.AMP_LOG_FILE = logPath;
      delete process.env.PLANNOTATOR_CWD;
      writeFileSync(
        logPath,
        JSON.stringify({
          pid: process.ppid,
          workspaceRoot: pathToFileURL(workspace).href,
        }),
        "utf8",
      );

      const cwd = await resolveCwd(commandContextWithCwd(pluginCwd));

      expect(cwd).toBe(workspace);
    } finally {
      restoreEnv("AMP_LOG_FILE", originalLogFile);
      restoreEnv("PLANNOTATOR_CWD", originalOverride);
      rmSync(tempDir, { recursive: true, force: true });
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

  test("does not let Amp's Bun mode leak into the Plannotator binary", () => {
    const originalBeBun = process.env.BUN_BE_BUN;

    try {
      process.env.BUN_BE_BUN = "1";
      expect(buildEnv({ PLANNOTATOR_ORIGIN: "amp" }).BUN_BE_BUN).toBeUndefined();
    } finally {
      restoreEnv("BUN_BE_BUN", originalBeBun);
    }
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

  test("prefers installer binary paths before PATH lookup", () => {
    expect(
      getPlannotatorCommandCandidates({
        home: "/Users/alice",
        pluginDir: "/Users/alice/.config/amp/plugins",
        platform: "darwin",
        env: {},
      }),
    ).toEqual([
      ["/Users/alice/.local/bin/plannotator"],
      ["plannotator"],
    ]);

    expect(
      getPlannotatorCommandCandidates({
        home: String.raw`C:\Users\alice`,
        pluginDir: String.raw`C:\Users\alice\.config\amp\plugins`,
        platform: "win32",
        env: {
          LOCALAPPDATA: String.raw`C:\Users\alice\AppData\Local`,
          USERPROFILE: String.raw`C:\Users\alice`,
        },
      }),
    ).toEqual([
      [String.raw`C:\Users\alice\AppData\Local\plannotator\plannotator.exe`],
      [String.raw`C:\Users\alice\.local\bin\plannotator.exe`],
      ["plannotator"],
    ]);
  });

  test("allows explicit PLANNOTATOR_BIN override", () => {
    expect(
      getPlannotatorCommandCandidates({
        home: "/Users/alice",
        pluginDir: "/Users/alice/.config/amp/plugins",
        platform: "darwin",
        env: { PLANNOTATOR_BIN: "/opt/plannotator/bin/plannotator" },
      }),
    ).toEqual([
      ["/opt/plannotator/bin/plannotator"],
      ["/Users/alice/.local/bin/plannotator"],
      ["plannotator"],
    ]);
  });
});

describe("Amp Plannotator registered commands", () => {
  test.each(["plannotator-review", "plannotator-review-target"])(
    "%s delivers rendered review messages and classifies only the decision",
    async (command) => {
      await withCommandHarness(async ({ run }) => {
        // #1456: this reviewer sentence used to be mistaken for a closed session.
        const feedback = "This path has no feedback loop, add one.";
        for (const result of [
          { decision: "annotated", message: `  Review guidance:\n\n${feedback}\n  ` },
          { decision: "approved", message: `Approved with non-blocking notes:\n\n${feedback}` },
          { decision: "approved", message: "Code review completed — no changes requested." },
        ]) {
          const delivered = await run(command, JSON.stringify(result), { input: "--git" });
          expect(delivered.appended).toEqual([{ type: "user-message", content: result.message }]);
          expect(delivered.notifications).toEqual([]);
        }

        // Deliberately not a legacy close phrase: the decision must control delivery.
        const message = "The reviewer closed this session.";
        const dismissed = await run(command, JSON.stringify({ decision: "dismissed", message }));
        expect(dismissed.appended).toEqual([]);
        expect(dismissed.notifications).toEqual([message]);
      });
    },
  );

  test.each(["plannotator-annotate", "plannotator-last"])(
    "%s delivers annotations and approval notes without interpreting reviewer prose",
    async (command) => {
      await withCommandHarness(async ({ run }) => {
        const feedback = "This path has no feedback loop, add one.";
        for (const decision of ["annotated", "approved"]) {
          const delivered = await run(command, JSON.stringify({ decision, feedback }));
          expect(delivered.appended).toEqual([
            { type: "user-message", content: expect.stringContaining(feedback) },
          ]);
          expect(delivered.notifications).toEqual([]);
          const content = delivered.appended[0].content;
          if (command === "plannotator-annotate") {
            expect(content).toContain("docs/plan.md");
          } else {
            expect(content).not.toContain("docs/plan.md");
          }
          if (decision === "approved") {
            // These semantics distinguish approval notes from a revision request.
            expect(content).toContain("non-blocking");
            expect(content).toContain("Do not revise or reopen");
          }
        }

        for (const feedback of [undefined, "   "]) {
          const approved = await run(command, JSON.stringify({ decision: "approved", feedback }));
          expect(approved.appended).toEqual([]);
          expect(approved.notifications).toEqual([expect.stringMatching(/approved/i)]);
        }

        const dismissed = await run(command, JSON.stringify({ decision: "dismissed", feedback }));
        expect(dismissed.appended).toEqual([]);
        expect(dismissed.notifications).toEqual([expect.stringMatching(/closed/i)]);

        const empty = await run(command, JSON.stringify({ decision: "annotated", feedback: "" }));
        expect(empty.appended).toEqual([]);
        expect(empty.notifications).toEqual([expect.stringMatching(/closed/i)]);
      });
    },
  );

  test("retains configured annotation prompts and Amp approval-note precedence", async () => {
    await withCommandHarness(async ({ run, configPath }) => {
      writeFileSync(configPath, JSON.stringify({
        prompts: {
          annotate: {
            fileFeedback: "File guidance for {{filePath}}:\n{{feedback}}",
            messageFeedback: "Generic message guidance:\n{{feedback}}",
            approvedWithNotes: "Generic approval:\n{{feedback}}",
            runtimes: {
              amp: {
                messageFeedback: "Amp message guidance:\n{{feedback}}",
                approvedWithNotes: "Amp approval:\n{{contextBlock}}{{feedback}}",
              },
            },
          },
        },
      }));
      const feedback = "This path has no feedback loop, add one.";
      const file = await run("plannotator-annotate", JSON.stringify({ decision: "annotated", feedback }));
      expect(file.appended).toEqual([
        { type: "user-message", content: `File guidance for docs/plan.md:\n${feedback}` },
      ]);
      const message = await run("plannotator-last", JSON.stringify({ decision: "annotated", feedback }));
      expect(message.appended).toEqual([
        { type: "user-message", content: `Amp message guidance:\n${feedback}` },
      ]);
      const approved = await run("plannotator-annotate", JSON.stringify({ decision: "approved", feedback }));
      expect(approved.appended).toEqual([
        { type: "user-message", content: `Amp approval:\nFile: docs/plan.md\n\n${feedback}` },
      ]);
    });
  });

  test.each([
    ["plannotator-review", "legacy plaintext", "This path has no feedback loop, add one."],
    ["plannotator-review", "empty stdout", ""],
    ["plannotator-review", "malformed JSON", '{"decision":"annotated","message":'],
    ["plannotator-review", "non-object JSON", "null"],
    ["plannotator-review", "missing rendered message", '{"decision":"approved","feedback":"Keep these notes."}'],
    ["plannotator-review", "invalid decision", '{"decision":"rejected","message":"Keep these notes."}'],
    ["plannotator-review", "invalid message type", '{"decision":"approved","message":{"text":"Keep these notes."}}'],
    ["plannotator-review", "multiple records", '{"decision":"approved","message":"First"}\n{"decision":"annotated","message":"Second"}'],
    ["plannotator-annotate", "legacy plaintext", "This path has no feedback loop, add one."],
    ["plannotator-annotate", "empty stdout", ""],
    ["plannotator-annotate", "invalid feedback type", '{"decision":"approved","feedback":{"text":"Keep these notes."}}'],
  ])("%s rejects %s and preserves captured output for recovery", async (command, _label, stdout) => {
    await withCommandHarness(async ({ run }) => {
      const stderr = "Diagnostic from the CLI";
      const delivered = await run(command, stdout, { stderr });
      expect(delivered.appended).toEqual([]);
      expect(delivered.notifications).toEqual([
        expect.stringMatching(/invalid structured output/i),
      ]);
      const notice = delivered.notifications[0];
      expect(notice).toMatch(/update.*CLI/i);
      expect(notice).toContain("https://plannotator.ai/docs/getting-started/installation/");
      expect(notice).toContain(stderr);
      if (stdout) {
        expect(notice).toContain(stdout);
      } else {
        expect(notice).toMatch(/empty stdout/i);
      }
    });
  });

  test("keeps process failures distinct from invalid successful output", async () => {
    await withCommandHarness(async ({ run }) => {
      const stdout = "Partial reviewer output";
      const stderr = "Unable to finish the review";
      const delivered = await run("plannotator-review", stdout, { stderr, status: 7 });
      expect(delivered.appended).toEqual([]);
      expect(delivered.notifications).toEqual([expect.stringMatching(/review failed/i)]);
      expect(delivered.notifications[0]).toContain(stdout);
      expect(delivered.notifications[0]).toContain(stderr);
    });
  });
});

interface CommandHarness {
  configPath: string;
  run: (
    command: string,
    stdout: string,
    options?: { input?: string; stderr?: string; status?: number },
  ) => Promise<{
    appended: Array<{ type: string; content: string }>;
    notifications: string[];
  }>;
}

async function withCommandHarness(run: (harness: CommandHarness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "plannotator-amp-commands-"));
  const originalEnv = { ...process.env };
  try {
    const home = join(root, "home");
    const dataDir = join(root, "data");
    mkdirSync(home);
    mkdirSync(dataDir);
    const cliPath = join(root, "fake-cli.ts");
    const resultPath = join(root, "result.json");
    const pluginPath = join(root, "plannotator.ts");
    // A separate module instance keeps the cached CLI runtime local to this test.
    copyFileSync(join(import.meta.dir, "plannotator.ts"), pluginPath);
    writeFileSync(cliPath, `
const result = await Bun.file(${JSON.stringify(resultPath)}).json();
if (process.argv.includes("--stdin")) await Bun.stdin.text();
process.stdout.write(process.argv.includes("--json") ? result.stdout : "CLI plaintext without --json");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 0);
`);
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_CWD: root,
      PLANNOTATOR_AMP_SOURCE_ENTRY: cliPath,
      AMP_LOG_FILE: join(root, "missing-amp.log"),
      PWD: root,
    });
    delete process.env.PLANNOTATOR_AMP_USE_SOURCE;
    delete process.env.PLANNOTATOR_BIN;

    const { default: plugin } = await import(pathToFileURL(pluginPath).href);
    const commands = new Map<string, (ctx: PluginCommandContext) => Promise<void>>();
    plugin({
      logger: { log() {} },
      registerCommand(name: string, _options: unknown, handler: (ctx: PluginCommandContext) => Promise<void>) {
        commands.set(name, handler);
      },
    } as unknown as PluginAPI);

    await run({
      configPath: join(dataDir, "config.json"),
      async run(command, stdout, options = {}) {
        writeFileSync(resultPath, JSON.stringify({ stdout, stderr: options.stderr, status: options.status }));
        const appended: Array<{ type: string; content: string }> = [];
        const notifications: string[] = [];
        const ctx = {
          ui: {
            input: async () => options.input ?? "docs/plan.md",
            notify: async (message: string) => { notifications.push(message); },
          },
          thread: {
            append: async (messages: typeof appended) => { appended.push(...messages); },
            messages: async () => [{
              role: "assistant",
              id: "message-1",
              content: [{ type: "text", text: "The answer to annotate." }],
            }],
          },
        } as unknown as PluginCommandContext;
        const handler = commands.get(command);
        if (!handler) throw new Error(`Command was not registered: ${command}`);
        await handler(ctx);
        return { appended, notifications };
      },
    });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value);
    rmSync(root, { recursive: true, force: true });
  }
}

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
