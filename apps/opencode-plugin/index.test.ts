import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PlannotatorPlugin from "./index";

const tempDirs: string[] = [];
const originalPlannotatorBin = process.env.PLANNOTATOR_BIN;
const originalShareUrl = process.env.PLANNOTATOR_SHARE_URL;
const originalPasteUrl = process.env.PLANNOTATOR_PASTE_URL;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-index-"));
  tempDirs.push(dir);
  return dir;
}

function installFakeCli(tempDir: string): {
  argsFile: string;
  stdinFile: string;
} {
  const argsFile = path.join(tempDir, "args.txt");
  const stdinFile = path.join(tempDir, "stdin.json");
  const fakeCli = path.join(tempDir, "plannotator-cli");
  writeFileSync(fakeCli, `#!/bin/sh
printf '%s\\n' "$@" > "$PLANNOTATOR_TEST_ARGS_FILE"
cat > "$PLANNOTATOR_TEST_STDIN_FILE"
printf '%s\\n' '{"decision":"dismissed"}'
`);
  chmodSync(fakeCli, 0o755);

  process.env.PLANNOTATOR_BIN = fakeCli;
  process.env.PLANNOTATOR_TEST_ARGS_FILE = argsFile;
  process.env.PLANNOTATOR_TEST_STDIN_FILE = stdinFile;
  process.env.PLANNOTATOR_SHARE_URL = "https://share.example.test";
  process.env.PLANNOTATOR_PASTE_URL = "https://paste.example.test";

  return { argsFile, stdinFile };
}

function makeClient(messages: any[] = []) {
  return {
    app: {
      log: mock((_entry: unknown) => {}),
      agents: mock(async (_input: unknown) => ({ data: [{ name: "build" }] })),
    },
    config: {
      get: mock(async (_input: unknown) => ({ data: { share: "disabled" } })),
    },
    session: {
      messages: mock(async (_input: unknown) => ({ data: messages })),
      prompt: mock(async (_input: unknown) => {}),
    },
  };
}

function hideBundledHtml(): () => void {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const restorePairs: Array<{ hiddenPath: string; originalPath: string }> = [];

  for (const filename of ["plannotator.html", "review-editor.html"]) {
    for (const originalPath of [
      path.join(pluginDir, filename),
      path.join(pluginDir, "..", filename),
    ]) {
      if (!existsSync(originalPath)) continue;
      const hiddenPath = path.join(makeTempDir(), filename);
      renameSync(originalPath, hiddenPath);
      restorePairs.push({ hiddenPath, originalPath });
    }
  }

  return () => {
    for (const { hiddenPath, originalPath } of restorePairs.reverse()) {
      if (!existsSync(hiddenPath) || existsSync(originalPath)) continue;
      renameSync(hiddenPath, originalPath);
    }
  };
}

afterEach(() => {
  if (originalPlannotatorBin === undefined) {
    delete process.env.PLANNOTATOR_BIN;
  } else {
    process.env.PLANNOTATOR_BIN = originalPlannotatorBin;
  }
  if (originalShareUrl === undefined) {
    delete process.env.PLANNOTATOR_SHARE_URL;
  } else {
    process.env.PLANNOTATOR_SHARE_URL = originalShareUrl;
  }
  if (originalPasteUrl === undefined) {
    delete process.env.PLANNOTATOR_PASTE_URL;
  } else {
    process.env.PLANNOTATOR_PASTE_URL = originalPasteUrl;
  }
  delete process.env.PLANNOTATOR_TEST_ARGS_FILE;
  delete process.env.PLANNOTATOR_TEST_STDIN_FILE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("OpenCode plugin command hook", () => {
  test("runtime cli routes plannotator-last through the CLI bridge even when embedded is available", async () => {
    const tempDir = makeTempDir();
    const { argsFile, stdinFile } = installFakeCli(tempDir);
    const client = makeClient([
      {
        info: { role: "assistant", id: "older", time: { created: 1_700_000_000_000 } },
        parts: [{ type: "text", text: "Older assistant message" }],
      },
      {
        info: { role: "assistant", id: "latest", time: { created: 1_700_000_001_000 } },
        parts: [{ type: "text", text: "Latest assistant message" }],
      },
    ]);

    const plugin = await PlannotatorPlugin(
      { client, directory: tempDir } as any,
      { workflow: "manual", runtime: "cli" },
    ) as any;
    const output = { parts: [{ type: "text", text: "command body" }] };

    await plugin["command.execute.before"](
      {
        command: "plannotator-last",
        sessionID: "session-123",
        arguments: "--gate",
      },
      output,
    );

    expect(output.parts).toEqual([]);
    expect(readFileSync(argsFile, "utf-8").trim()).toBe("opencode-annotate-last");

    const payload = JSON.parse(readFileSync(stdinFile, "utf-8"));
    expect(payload.gate).toBe(true);
    expect(payload.sharingEnabled).toBe(false);
    expect(payload.shareBaseUrl).toBe("https://share.example.test");
    expect(payload.pasteApiUrl).toBe("https://paste.example.test");
    expect(payload.recentMessages).toEqual([
      {
        messageId: "latest",
        text: "Latest assistant message",
        timestamp: new Date(1_700_000_001_000).toISOString(),
      },
      {
        messageId: "older",
        text: "Older assistant message",
        timestamp: new Date(1_700_000_000_000).toISOString(),
      },
    ]);
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  test("runtime cli routes plannotator-annotate through the CLI bridge", async () => {
    const tempDir = makeTempDir();
    const { argsFile, stdinFile } = installFakeCli(tempDir);
    const client = makeClient();

    const plugin = await PlannotatorPlugin(
      { client, directory: tempDir } as any,
      { workflow: "manual", runtime: "cli" },
    ) as any;
    const output = { parts: [{ type: "text", text: "command body" }] };

    await plugin["command.execute.before"](
      {
        command: "plannotator-annotate",
        sessionID: "session-123",
        arguments: "notes.md --gate",
      },
      output,
    );

    expect(output.parts).toEqual([]);
    expect(readFileSync(argsFile, "utf-8").trim().split("\n")).toEqual([
      "annotate",
      "notes.md",
      "--json",
      "--gate",
    ]);
    expect(readFileSync(stdinFile, "utf-8")).toBe("");
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  test("runtime cli routes plannotator-review through the CLI bridge", async () => {
    const tempDir = makeTempDir();
    const { argsFile, stdinFile } = installFakeCli(tempDir);
    const client = makeClient();

    const plugin = await PlannotatorPlugin(
      { client, directory: tempDir } as any,
      { workflow: "manual", runtime: "cli" },
    ) as any;
    const output = { parts: [{ type: "text", text: "command body" }] };

    await plugin["command.execute.before"](
      {
        command: "plannotator-review",
        sessionID: "session-123",
        arguments: "--base main",
      },
      output,
    );

    expect(output.parts).toEqual([]);
    expect(readFileSync(argsFile, "utf-8").trim()).toBe("opencode-review");

    const payload = JSON.parse(readFileSync(stdinFile, "utf-8"));
    expect(payload.arguments).toBe("--base main");
    expect(payload.sharingEnabled).toBe(false);
    expect(payload.shareBaseUrl).toBe("https://share.example.test");
    expect(payload.pasteApiUrl).toBe("https://paste.example.test");
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  test("runtime cli submit_plan does not require bundled HTML assets", async () => {
    const restoreBundledHtml = hideBundledHtml();
    try {
      const tempDir = makeTempDir();
      const { argsFile, stdinFile } = installFakeCli(tempDir);
      const client = makeClient();

      const plugin = await PlannotatorPlugin(
        { client, directory: tempDir } as any,
        { runtime: "cli" },
      ) as any;

      const result = await plugin.tool.submit_plan.execute(
        {
          edits: [{
            start: 1,
            content: "# Plan\n\nUse the CLI bridge.",
          }],
        },
        { agent: "plan", sessionID: "session-123" },
      );

      expect(result).toContain("Plan changes requested");
      expect(readFileSync(argsFile, "utf-8").trim()).toBe("opencode-plan");

      const payload = JSON.parse(readFileSync(stdinFile, "utf-8"));
      expect(payload.plan).toBe("# Plan\n\nUse the CLI bridge.");
      expect(payload.sharingEnabled).toBe(false);
      expect(payload.shareBaseUrl).toBe("https://share.example.test");
      expect(payload.pasteApiUrl).toBe("https://paste.example.test");
    } finally {
      restoreBundledHtml();
    }
  });
});
