import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleCliCommand } from "./cli-bridge";

describe("the session that opened a review", () => {
  test.skipIf(process.platform === "win32")("the review input names the OpenCode session, and a CLI that ignores the field still opens the review", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-live-"));
    mkdirSync(path.join(root, "repo"));
    const seen = path.join(root, "input.json");
    const binary = path.join(root, "cli.ts");
    writeFileSync(binary, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const input = await Bun.stdin.text();
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ command: process.argv[2], input: JSON.parse(input) }));
console.log(JSON.stringify({ decision: "annotated", feedback: "looks fine" }));
`, { mode: 0o755 });
    const client = {
      app: { log: mock((_entry: { message: string }) => {}) },
      session: { prompt: mock(async (_input: unknown) => ({})) },
      tui: { showToast: mock((_input: unknown) => {}) },
    };
    const previous = process.env.PLANNOTATOR_BIN;
    try {
      process.env.PLANNOTATOR_BIN = binary;
      await handleCliCommand({ command: "plannotator-review", client, sessionId: "ses_oc_7d21", cwd: path.join(root, "repo"), rawArgs: "" });
      const { command, input } = JSON.parse(readFileSync(seen, "utf8")) as { command: string; input: Record<string, unknown> };
      expect(command).toBe("opencode-review");
      expect(input.inboxSession).toBe("ses_oc_7d21");
      expect(client.session.prompt).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_BIN;
      else process.env.PLANNOTATOR_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
