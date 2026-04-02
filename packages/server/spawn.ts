/**
 * Standalone spawn mode — launches a new interactive `claude` session
 * with review feedback instead of writing hook output to stdout.
 *
 * Detection:  --spawn CLI flag  OR  PLANNOTATOR_SPAWN=1|true env var
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Check if spawn mode is active.
 * Call this in the CLI entry point, NOT in server code.
 */
export function isSpawnMode(): boolean {
  const envVal = process.env.PLANNOTATOR_SPAWN?.toLowerCase() ?? "";
  return process.argv.includes("--spawn") || envVal === "1" || envVal === "true";
}

/**
 * Spawn an interactive `claude` session with the given prompt.
 * Writes prompt to a temp file and passes a short reference as the initial message.
 * Returns the exit code of the `claude` process.
 */
export async function spawnClaudeSession(
  projectRoot: string,
  prompt: string,
): Promise<number> {
  const feedbackPath = join(tmpdir(), `plannotator-spawn-${Date.now()}.md`);
  await Bun.write(feedbackPath, prompt);

  try {
    const proc = Bun.spawn(
      ["claude", `Read and act on the review feedback in ${feedbackPath}`],
      {
        cwd: projectRoot,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exitCode = await proc.exited;
    return exitCode;
  } finally {
    await unlink(feedbackPath).catch(() => {}); // best-effort cleanup
  }
}
