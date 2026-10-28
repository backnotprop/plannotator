import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../helpers/no-browser";

/**
 * Sandbox every test-run store before production modules capture their paths.
 * Override even a contributor's configured data directory; tests that need a
 * different directory can set and restore the env var inside their bodies.
 */
const testDataDir = mkdtempSync(join(tmpdir(), "plannotator-test-"));
process.env.PLANNOTATOR_DATA_DIR = testDataDir;
// Marks the sandbox for tests/helpers/real-data-dir.ts (the scratch check the
// Inbox helpers and tests/setup/sandbox-data-dir.ts apply).
process.env.PLANNOTATOR_TEST_SANDBOX = testDataDir;

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

// The Inbox publishes itself over the tailnet when this is on: a contributor
// who set it in their shell must not make every Inbox test run the real
// `tailscale` CLI. Tests that need it inject a scripted runner.
delete process.env.PLANNOTATOR_INBOX_TAILSCALE;

// `plannotator inbox` connects the agents it finds on PATH (packages/server/
// inbox-agents.ts) by running their own CLIs. Tests never run a real agent
// CLI: every process that inherits this environment skips the step. The
// connect proofs turn it on in their own spawned env, with a PATH of fakes.
process.env.PLANNOTATOR_INBOX_CONNECT = "0";

// The update check asks GitHub about once an hour from a release build (the Inbox with
// an X.Y.Z version, the compiled CLI). Tests never reach GitHub: a closed
// loopback port refuses at once, so an unintended check fails fast and is
// cached as a failure. Tests that need an answer inject `fetchRelease` or
// serve a fake API and set this in their own bodies or spawned env.
process.env.PLANNOTATOR_UPDATE_API_URL = "http://127.0.0.1:9/releases/latest";

// Product feedback (the Inbox's Feedback dialog, `plannotator feedback`): never
// the live Worker, whose table is append-only, so one stray row needs a trigger
// dropped by hand. A closed loopback port refuses at once ("Couldn't send
// feedback right now"). Overrides a contributor's own value too. Tests that
// send point it (or the Inbox's `feedbackUrl` option) at a local fake in their
// own bodies or spawned env. tests/feedback-live-url.test.ts guards both.
process.env.PLANNOTATOR_FEEDBACK_URL = "http://127.0.0.1:9/feedback";

// The install script the update wrapper downloads: never the real one. A closed
// loopback port refuses at once, so an unintended Update now fails fast.
process.env.PLANNOTATOR_INSTALL_SCRIPT_URL = "http://127.0.0.1:9/install.sh";
// The .sha256 files `update-prepare` downloads next to it: never GitHub's.
process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL = "http://127.0.0.1:9/download";

// Every session a test starts, in this process or in a child that inherits
// this environment, runs a program that exits at once instead of a browser.
// Not a sentinel such as `none`: packages/server/browser.ts reads those as
// unset and opens the system default browser (tests/helpers/no-browser.ts).
// Overrides a contributor's own value too (a VS Code terminal sets one that
// routes every session into an editor tab). Tests of the browser launch set
// and restore their own value inside their bodies.
process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
