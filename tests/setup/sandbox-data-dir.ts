/**
 * The bunfig preload's data-dir sandbox (tests/setup/feedback-archive-off.ts),
 * as an import that works without bunfig. Bun reads only the bunfig.toml in
 * the directory `bun test` runs from, so a run from a folder without one (or
 * by absolute path from elsewhere) skips the preload; the Playwright specs run
 * under node with no preload at all. Every Inbox test helper imports this
 * first, so whatever the runner:
 *
 *  - PLANNOTATOR_DATA_DIR unset: it becomes a fresh temp folder, removed when
 *    the process exits;
 *  - PLANNOTATOR_DATA_DIR naming the person's real data directory (or a
 *    folder inside it): the import throws, and the test file fails before it
 *    starts, signals or removes anything.
 *
 * Node-safe (no Bun APIs).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refuseRealDataDir } from "../helpers/real-data-dir";

if (!process.env.PLANNOTATOR_DATA_DIR?.trim()) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-test-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.once("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: it is a temp folder.
    }
  });
}
refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "tests/setup/sandbox-data-dir.ts");
