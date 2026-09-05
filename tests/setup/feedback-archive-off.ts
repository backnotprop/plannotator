import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Sandbox every test-run store before production modules capture their paths.
 * Override even a contributor's configured data directory; tests that need a
 * different directory can set and restore the env var inside their bodies.
 */
const testDataDir = mkdtempSync(join(tmpdir(), "plannotator-test-"));
process.env.PLANNOTATOR_DATA_DIR = testDataDir;

// A preload's global afterAll runs after file hooks and their awaited subprocesses.
// Use the runner lifecycle: bun test does not reliably emit process "exit".
// Only this process owns this path: never clean up the current env value, which
// a test may have overridden, or a directory inherited from a parent test run.
afterAll(() => {
  rmSync(testDataDir, { recursive: true, force: true });
});

// Keep the archive off by default, even when enabled in the contributor's shell.
// Archive tests opt back in inside their bodies and restore it in afterEach.
process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
