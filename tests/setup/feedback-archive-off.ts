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

// The agent tool switch decides whether the plannotator tool is registered at
// all; a contributor who set it in their shell must not change what the tests
// see (host defaults apply). Tests that need it on set it in their bodies.
delete process.env.PLANNOTATOR_AGENT_TOOL;

// The Inbox makes a relay mailbox at a phone's first pairing (packages/server/
// inbox-relay.ts). Tests never reach the hosted relay: a closed loopback port
// refuses at once, so a pairing answers `relay: null`. The relay's own proof
// (apps/relay/test) sets its `wrangler dev` URL in the env it spawns.
process.env.PLANNOTATOR_RELAY_URL = "http://127.0.0.1:9";
