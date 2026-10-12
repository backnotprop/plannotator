/**
 * The bunfig preload's data-dir sandbox (tests/setup/feedback-archive-off.ts),
 * as an import that works without bunfig. Bun reads only the bunfig.toml in
 * the directory `bun test` runs from, so a run from a folder without one (or
 * by absolute path from elsewhere) skips the preload; the Playwright specs run
 * under node with no preload at all. Every Inbox test helper imports this
 * first, and it does what the preload does: PLANNOTATOR_DATA_DIR becomes a
 * fresh temp folder (removed when the process exits), marked with
 * PLANNOTATOR_TEST_SANDBOX, unless it already is a scratch folder (inside the
 * OS temp dir or /tmp, such as CI's `mktemp -d`, or the sandbox the preload
 * marked). A value from the person's shell (`/custom`, `~/.plannotator`) is
 * their real Inbox and is replaced, never used.
 *
 * Node-safe (no Bun APIs).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isScratchDataDir, refuseRealDataDir, TEST_SANDBOX_ENV } from "../helpers/real-data-dir";

const current = process.env.PLANNOTATOR_DATA_DIR?.trim();
if (!current || !isScratchDataDir(current)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-test-")));
  if (current) process.stderr.write(`tests/setup/sandbox-data-dir.ts: PLANNOTATOR_DATA_DIR=${current} is not a scratch folder; using ${dir} instead.\n`);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env[TEST_SANDBOX_ENV] = dir;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: it is a temp folder.
    }
  });
}
refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "tests/setup/sandbox-data-dir.ts");
