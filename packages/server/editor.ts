/**
 * Editor diff utility — opens plan diffs in external editors
 */

import { mkdirSync, writeFileSync } from "fs";
import { UPLOAD_DIR } from "./image";

/**
 * Write two plan versions to temp files and open them in VS Code's diff viewer.
 *
 * Returns `{ ok: true }` on success or `{ error: string }` on failure.
 */
export async function openEditorDiff(
  oldContent: string,
  newContent: string,
  opts: { baseVersion: number }
): Promise<{ ok: true } | { error: string }> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const oldPath = `${UPLOAD_DIR}/plan-v${opts.baseVersion}.md`;
  const newPath = `${UPLOAD_DIR}/plan-current.md`;

  writeFileSync(oldPath, oldContent);
  writeFileSync(newPath, newContent);

  try {
    const proc = Bun.spawn(["code", "--diff", oldPath, newPath], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      if (stderr.includes("not found") || stderr.includes("ENOENT")) {
        return {
          error:
            "VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
        };
      }
      return { error: `code --diff exited with ${exitCode}: ${stderr}` };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to open diff";
    if (msg.includes("ENOENT") || msg.includes("not found")) {
      return {
        error:
          "VS Code CLI not found. Run 'Shell Command: Install code command in PATH' from the VS Code command palette.",
      };
    }
    return { error: msg };
  }
}
