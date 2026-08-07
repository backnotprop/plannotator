import { describe, expect, test } from "bun:test";
import { buildCodexCommand } from "./codex-review";
import { buildGuideCodexCommand } from "./guide/guide-review";
import { buildTourCodexCommand } from "./tour/tour-review";

describe("Codex command builders", () => {
  test("use the current automatic approval flag for every review surface", async () => {
    const options = {
      cwd: "/tmp/project",
      outputPath: "/tmp/output.json",
      prompt: "Review these changes.",
    };
    const commands = await Promise.all([
      buildCodexCommand(options),
      buildGuideCodexCommand(options),
      buildTourCodexCommand(options),
    ]);

    for (const command of commands) {
      expect(command).toContain("--approve-for-me");
      expect(command).not.toContain("--full-auto");
    }
  });
});
