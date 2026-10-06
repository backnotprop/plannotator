import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  annotateCliTargets,
  buildAnnotateCliArgs,
  buildAnnotatePromptFromBridgeOutcome,
  buildCliBridgeEnv,
  buildCliSpawnConfig,
  buildReviewPromptFromBridgeOutcome,
  canLaunchGatedAnnotate,
  formatUserFacingCliStderrLine,
  getRecentAssistantMessages,
  handleCliCommand,
  injectSessionPrompt,
} from "./cli-bridge";
import { composeReviewApprovedMessage, getReviewApprovedPrompt, getReviewDeniedSuffix } from "@plannotator/shared/prompts";
import { OpenCodePromptDeliveryError } from "./prompt-delivery-error";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";

describe("OpenCode CLI bridge helpers", () => {
  test.skipIf(process.platform === "win32")("an older CLI refuses directory reviews before opening the caller repo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-review-skew-"));
    mkdirSync(path.join(root, "caller"));
    mkdirSync(path.join(root, "target"));
    const binary = path.join(root, "old-cli.ts");
    const opened = path.join(root, "review-opened");
    const previous = process.env.PLANNOTATOR_BIN;
    // Model the old binary's contract: opencode-review ignores positional
    // words; unknown commands exit before opening any UI.
    writeFileSync(binary, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
await Bun.stdin.text();
if (process.argv[2] !== "opencode-review") {
  console.error("Unknown command: " + process.argv[2]);
  process.exit(1);
}
writeFileSync(${JSON.stringify(opened)}, "opened");
console.log(JSON.stringify({ decision: "annotated", feedback: "caller feedback" }));
`, { mode: 0o755 });
    const client = {
      app: { log: mock((_entry: { message: string }) => {}) },
      session: { prompt: mock(async (_input: unknown) => ({})) },
      tui: { showToast: mock((_input: any) => {}) },
    };
    const toasts = () => client.tui.showToast.mock.calls.map(([entry]) => entry.body.message).join("\n");
    try {
      process.env.PLANNOTATOR_BIN = binary;
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "caller", cwd: path.join(root, "caller"), rawArgs: "../target" });
      expect(existsSync(opened)).toBe(false);
      expect(client.session.prompt).not.toHaveBeenCalled();
      expect(client.app.log.mock.calls.map(([entry]) => entry.message).join("\n")).toContain("Update the Plannotator CLI");
      expect(toasts()).toContain("Update the Plannotator CLI");
      // Binaries older than 0.27.11 have no unknown-command guard: the stdin
      // JSON reaches the plan hook path, which fails with its own message.
      const ancient = path.join(root, "ancient-cli.ts");
      writeFileSync(ancient, `#!/usr/bin/env bun
await Bun.stdin.text();
console.error("No plan content in hook event");
process.exit(1);
`, { mode: 0o755 });
      process.env.PLANNOTATOR_BIN = ancient;
      client.app.log.mockClear();
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "caller", cwd: path.join(root, "caller"), rawArgs: "../target" });
      expect(client.app.log.mock.calls.map(([entry]) => entry.message).join("\n")).toContain("Update the Plannotator CLI");
      process.env.PLANNOTATOR_BIN = binary;
      // Prose names no directory, so it keeps the old command and still works
      // against an old binary exactly as before (#1483 tolerance).
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "caller", cwd: path.join(root, "caller"), rawArgs: "please review my changes" });
      expect(existsSync(opened)).toBe(true);
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
      // Path-shaped prose among several words is ignored, not refused, and
      // still takes the old command (v0.27.23 regression).
      rmSync(opened);
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "caller", cwd: path.join(root, "caller"), rawArgs: "look at the api/users code" });
      expect(existsSync(opened)).toBe(true);
      // A sole path-shaped typo is refused before the CLI runs, visibly.
      rmSync(opened);
      client.tui.showToast.mockClear();
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "caller", cwd: path.join(root, "caller"), rawArgs: "./backnd" });
      expect(existsSync(opened)).toBe(false);
      expect(toasts()).toContain("does not exist");
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_BIN;
      else process.env.PLANNOTATOR_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000); // spawns the stub CLI several times; the 5s default flakes

  // Several file paths are one review: each path its own CLI argument (one
  // joined argument would be "File not found"), the agent's prompt names
  // every file, and an older CLI's "pick one" error reads as "update".
  test.skipIf(process.platform === "win32")("several file paths reach the CLI as one review; an older CLI reads as update", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-annotate-bundle-bridge-"));
    writeFileSync(path.join(root, "spec.md"), "# Spec\n");
    writeFileSync(path.join(root, "mock.html"), "<h1>Mock</h1>");
    const argvFile = path.join(root, "argv.json");
    const current = path.join(root, "cli.ts");
    writeFileSync(current, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ decision: "annotated", feedback: "two notes" }));
`, { mode: 0o755 });
    const older = path.join(root, "older-cli.ts");
    writeFileSync(older, `#!/usr/bin/env bun
console.error("Ambiguous annotate arguments: 2 of them each resolve to an existing target.\\nRe-run with exactly one target: plannotator annotate <file>");
process.exit(1);
`, { mode: 0o755 });
    const client = {
      app: { log: mock((_entry: { message: string }) => {}) },
      session: { prompt: mock(async (_input: unknown) => ({})) },
      tui: { showToast: mock((_input: any) => {}) },
    };
    const previous = process.env.PLANNOTATOR_BIN;
    try {
      process.env.PLANNOTATOR_BIN = current;
      await handleCliCommand({ command: "plannotator-annotate", client, sessionId: "s1", cwd: root, rawArgs: "spec.md mock.html" });
      expect(JSON.parse(readFileSync(argvFile, "utf8"))).toEqual([
        "annotate",
        path.join(root, "spec.md"),
        path.join(root, "mock.html"),
        "--json",
      ]);
      const delivered = JSON.stringify(client.session.prompt.mock.calls[0]?.[0]);
      expect(delivered).toContain(path.join(root, "spec.md"));
      expect(delivered).toContain(path.join(root, "mock.html"));

      process.env.PLANNOTATOR_BIN = older;
      client.app.log.mockClear();
      await handleCliCommand({ command: "plannotator-annotate", client, sessionId: "s1", cwd: root, rawArgs: "spec.md mock.html" });
      expect(client.app.log.mock.calls.map(([entry]) => entry.message).join("\n")).toContain("update Plannotator to open several files at once");
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_BIN;
      else process.env.PLANNOTATOR_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("maps OpenCode sharing context into child CLI env", () => {
    expect(buildCliBridgeEnv({
      sharingEnabled: false,
      shareBaseUrl: "https://share.example.test",
      pasteApiUrl: "https://paste.example.test",
    })).toEqual({
      PLANNOTATOR_SHARE: "disabled",
      PLANNOTATOR_SHARE_URL: "https://share.example.test",
      PLANNOTATOR_PASTE_URL: "https://paste.example.test",
    });

    expect(buildCliBridgeEnv({ sharingEnabled: true })).toEqual({
      PLANNOTATOR_SHARE: "enabled",
    });
  });

  test("marks a host that can register the plannotator tool, and only that one", () => {
    // What lets the child's Settings offer the agent tool switch: a host
    // without a tool domain (or OpenCode 1) must not get it.
    expect(buildCliBridgeEnv({ toolCapable: true })).toEqual({ PLANNOTATOR_OPENCODE_TOOL_CAPABLE: "1" });
    expect(buildCliBridgeEnv({ sharingEnabled: true })).not.toHaveProperty("PLANNOTATOR_OPENCODE_TOOL_CAPABLE");
  });

  test("builds annotate CLI args without folding flags into the path", () => {
    const args = buildAnnotateCliArgs({
      filePath: "https://example.com/docs",
      rawFilePath: "https://example.com/docs",
      gate: true,
      json: false,
      hook: false,
      renderHtml: true,
      renderMarkdown: false,
      noJina: true,
    });

    expect(args).toEqual([
      "annotate",
      "https://example.com/docs",
      "--json",
      "--gate",
      "--render-html",
      "--no-jina",
    ]);
  });

  test("passes annotate markdown flag through to the child CLI", () => {
    const args = buildAnnotateCliArgs({
      filePath: "plan.html",
      rawFilePath: "plan.html",
      gate: false,
      json: false,
      hook: false,
      renderHtml: false,
      renderMarkdown: true,
      noJina: false,
    });

    expect(args).toEqual([
      "annotate",
      "plan.html",
      "--json",
      "--markdown",
    ]);
  });

  // Failure caught: a slash command's words passed as ONE argument (the real
  // CLI reads ". notes.md" as one path), an unquoted path with spaces split
  // into words, or a dash word in prose reaching the CLI as a real flag.
  test("slash-command annotate words become separate CLI arguments only when the whole names nothing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-annotate-words-"));
    try {
      writeFileSync(path.join(root, "notes.md"), "# Notes\n");
      writeFileSync(path.join(root, "my notes.md"), "# Notes\n");
      const targets = (raw: string) => annotateCliTargets(parseAnnotateArgs(raw), raw, root);
      expect(targets(". notes.md")).toEqual([".", "notes.md"]);
      expect(targets('"my notes.md" please --gate')).toEqual(["my notes.md", "please"]);
      expect(targets("my notes.md")).toEqual(["my notes.md"]);
      expect(targets("nothere.md")).toEqual(["nothere.md"]);
      // A URL with prose after it once went to the CLI as one "URL".
      expect(targets("https://example.com/page the pricing part")).toEqual(["https://example.com/page", "the", "pricing", "part"]);
      expect(targets("https://example.com/page")).toEqual(["https://example.com/page"]);
      expect(targets("notes.md --require-approval")).toEqual(["notes.md --require-approval"]);
      expect(buildAnnotateCliArgs(parseAnnotateArgs(". notes.md --gate"), targets(". notes.md --gate")))
        .toEqual(["annotate", ".", "notes.md", "--json", "--gate"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires a session before launching a gated capable annotate bridge", () => {
    expect(canLaunchGatedAnnotate({ gate: true }, undefined)).toBe(false);
    expect(canLaunchGatedAnnotate({ gate: true }, "session-1")).toBe(true);
    expect(canLaunchGatedAnnotate({ gate: false }, undefined)).toBe(true);
  });

  test("formats approved feedback as non-blocking notes while retaining file context", () => {
    const outcome = {
      decision: "approved" as const,
      feedback: "Keep the retry bounded.",
    };

    const filePrompt = buildAnnotatePromptFromBridgeOutcome(outcome, {
      kind: "file",
      fileHeader: "File",
      filePath: "plan.md",
    });
    expect(filePrompt).toContain("artifact is approved");
    expect(filePrompt).toContain("non-blocking guidance");
    expect(filePrompt).toContain("File: plan.md");
    expect(filePrompt).toContain("Keep the retry bounded.");
    expect(filePrompt).not.toContain("Please address");

    const messagePrompt = buildAnnotatePromptFromBridgeOutcome(outcome, {
      kind: "message",
    });
    expect(messagePrompt).toContain("artifact is approved");
    expect(messagePrompt).toContain("Keep the retry bounded.");
    expect(messagePrompt).not.toContain("File:");
    expect(messagePrompt).not.toContain("Please address");

    expect(buildAnnotatePromptFromBridgeOutcome({
      decision: "approved",
      feedback: "",
    }, {
      kind: "message",
    })).toBeNull();
  });

  test("keeps annotated feedback on the ordinary revision-request prompt path", () => {
    const prompt = buildAnnotatePromptFromBridgeOutcome({
      decision: "annotated",
      feedback: "Tighten the timeout.",
    }, {
      kind: "message",
    });

    expect(prompt).toContain("Please address");
    expect(prompt).not.toContain("artifact is approved");
  });

  // #1701: the CLI's --json record for a bare Done keeps the zero-state
  // sentence as feedback and adds nothingToSend; the bridge starts no turn.
  test("a Done with nothing to send builds no prompt", () => {
    for (const target of [{ kind: "message" as const }, { kind: "file" as const, fileHeader: "File" as const, filePath: "notes.md" }]) {
      expect(buildAnnotatePromptFromBridgeOutcome({
        decision: "annotated",
        feedback: "User reviewed the document and has no feedback.",
        nothingToSend: true,
      }, target)).toBeNull();
    }
  });

  test("classifies CLI bridge prompt-delivery failures for fallback prevention", async () => {
    const client = {
      app: { log: mock(() => {}) },
      session: {
        prompt: mock(async () => {
          throw new Error("session busy");
        }),
      },
    };

    try {
      await injectSessionPrompt(client, "session-1", "Approved notes");
      throw new Error("Expected prompt delivery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodePromptDeliveryError);
    }
    expect(client.app.log).toHaveBeenCalledWith({
      level: "error",
      message: expect.stringContaining("Could not deliver Plannotator feedback"),
    });
  });

  test("surfaces remote share-link stderr lines and ignores noisy stderr", () => {
    expect(formatUserFacingCliStderrLine("  Open this link on your local machine to review the plan:")).toBe(
      "Open this link on your local machine to review the plan:",
    );
    expect(formatUserFacingCliStderrLine("  https://share.plannotator.ai/#abc")).toBe(
      "https://share.plannotator.ai/#abc",
    );
    expect(formatUserFacingCliStderrLine("  (1.2 KB - plan only, annotations added in browser)")).toBe(
      "(1.2 KB - plan only, annotations added in browser)",
    );
    expect(formatUserFacingCliStderrLine("Fetching: https://example.com")).toBeUndefined();
  });

  test("resolves Windows CLI commands to an executable without shell mode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plannotator-cli-"));
    try {
      const exe = path.join(dir, "plannotator.exe");
      writeFileSync(exe, "");

      const config = buildCliSpawnConfig(
        "plannotator",
        ["annotate", "my notes.md", "--json"],
        "win32",
        {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      );

      expect(config).toEqual({
        command: exe,
        args: ["annotate", "my notes.md", "--json"],
        shell: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("collects recent assistant messages newest-first with ids and timestamps", async () => {
    const client = {
      session: {
        messages: mock(async () => ({
          data: [
            {
              info: { role: "assistant", id: "old", time: { created: 1_700_000_000_000 } },
              parts: [{ type: "text", text: "Old" }],
            },
            {
              info: { role: "user", id: "user" },
              parts: [{ type: "text", text: "Ignore me" }],
            },
            {
              info: { role: "assistant", id: "latest", time: { created: 1_700_000_001_000 } },
              parts: [{ type: "text", text: "Latest" }],
            },
          ],
        })),
      },
    };

    const messages = await getRecentAssistantMessages(client, "session-1");

    expect(messages).toEqual([
      {
        messageId: "latest",
        text: "Latest",
        timestamp: new Date(1_700_000_001_000).toISOString(),
      },
      {
        messageId: "old",
        text: "Old",
        timestamp: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
  });

  test("formats structured review outcomes for OpenCode prompt injection", () => {
    expect(buildReviewPromptFromBridgeOutcome({
      decision: "dismissed",
    })).toEqual({ message: null });

    const approved = buildReviewPromptFromBridgeOutcome({
      decision: "approved",
      approved: true,
      agentSwitch: "build",
    });
    expect(approved.agent).toBe("build");
    expect(approved.message).toBe(getReviewApprovedPrompt("opencode"));

    // PR5 delivery (spec §6.4, consumer #3): an approval carrying feedback
    // must route through the shared approved-with-notes composer — this
    // bridge previously discarded it even though the CLI's JSON record always
    // included it. The framing itself is pinned in prompts.test.ts; here we
    // guard the wiring: the note is delivered, inside the composed message.
    const note = "Approved — rename the flag in a follow-up.";
    const approvedWithNotes = buildReviewPromptFromBridgeOutcome({
      decision: "approved",
      approved: true,
      feedback: note,
    });
    expect(approvedWithNotes.message).toBe(composeReviewApprovedMessage("opencode", note));
    expect(approvedWithNotes.message).toContain(note);

    const localFeedback = buildReviewPromptFromBridgeOutcome({
      decision: "annotated",
      approved: false,
      isPRMode: false,
      feedback: "Fix these issues.",
      agentSwitch: "disabled",
    });
    expect(localFeedback.agent).toBeUndefined();
    expect(localFeedback.message).toContain("Fix these issues.");
    // Assert against the actual suffix (not a hardcoded copy) so future edits to
    // the review trailer don't break this wiring test.
    expect(localFeedback.message).toContain(getReviewDeniedSuffix("opencode"));

    const prFeedback = buildReviewPromptFromBridgeOutcome({
      decision: "annotated",
      approved: false,
      isPRMode: true,
      feedback: "PR comment only.",
    });
    // An older CLI sends no `platform`; isPRMode stays the fallback.
    expect(prFeedback.message).toBe("PR comment only.");
  });

  // A CLI that knows the flag always sends it as a boolean, so PR-mode
  // feedback (including PR description / PR comment notes, which carry no
  // code annotations) gets the suffix, and only the platform status post
  // goes through verbatim.
  test("the CLI's platform flag, not isPRMode, decides the verbatim status post", () => {
    const prFeedback = buildReviewPromptFromBridgeOutcome({
      decision: "annotated",
      approved: false,
      isPRMode: true,
      platform: false,
      feedback: "## PR description\n\n> Adds the parser\n\nExplain the fallback.",
    });
    expect(prFeedback.message).toContain("Explain the fallback.");
    expect(prFeedback.message).toContain(getReviewDeniedSuffix("opencode"));

    const statusPost = buildReviewPromptFromBridgeOutcome({
      decision: "annotated",
      approved: false,
      isPRMode: true,
      platform: true,
      feedback: "Pull request reviewed on GitHub: https://github.com/o/r/pull/1",
    });
    expect(statusPost.message).toBe("Pull request reviewed on GitHub: https://github.com/o/r/pull/1");
  });
});
