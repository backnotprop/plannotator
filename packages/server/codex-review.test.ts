import { describe, expect, test } from "bun:test";
import { buildCodexCommand } from "./codex-review";

describe("buildCodexCommand", () => {
  test("uses the current non-interactive read-only Codex flags", async () => {
    const command = await buildCodexCommand({
      cwd: "/tmp",
      outputPath: "/tmp/out.json",
      prompt: "Review this change.",
    });

    expect(command).toContain("--sandbox");
    expect(command).toContain("read-only");
    expect(command).toContain("--approve-for-me");
    expect(command).not.toContain("--full-auto");
  });
});
