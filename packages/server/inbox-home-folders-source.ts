/**
 * The folder rules (`inbox-home-folders.ts`) as one self-contained module, for the child process that reads folders
 * outside home (`inbox-folder-reader.ts`). Imported as a Bun macro, so it runs when the Inbox is built (and when Bun
 * loads it from source): the compiled binary carries the text, with no file to read at run time. Bundled, not read as
 * is, so a helper the rules import from this folder (a platform's own folder rules) goes into the child too.
 * `Bun.build` can't run inside a macro (the bundler waits on it), so it is Bun's own `build` command.
 */
import { join } from "node:path";

export function homeFoldersSource(): string {
  const entry = join(import.meta.dir, "inbox-home-folders.ts");
  const built = Bun.spawnSync([process.execPath, "build", entry, "--target=bun", "--format=esm", "--packages=external"], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (!built.success) throw new Error(`The folder rules didn't bundle: ${built.stderr.toString()}`);
  return built.stdout.toString();
}
