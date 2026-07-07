import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAnnotateCliArgs,
  buildCliBridgeEnv,
  buildCliSpawnConfig,
  buildReviewPromptFromBridgeOutcome,
  formatUserFacingCliStderrLine,
  getRecentAssistantMessages,
} from "./cli-bridge";
import { getReviewDeniedSuffix } from "@plannotator/shared/prompts";

describe("OpenCode CLI bridge helpers", () => {
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
    expect(approved.message).toContain("Code Review");

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
    expect(prFeedback.message).toBe("PR comment only.");
  });
});
