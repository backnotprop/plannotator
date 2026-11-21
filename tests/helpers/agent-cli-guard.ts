/**
 * The agent CLI stubs (tests/e2e/agent-cli-stubs.ts) for a bun test's child
 * processes. A CLI or Inbox a test spawns looks agents up on the PATH it was
 * given, so `PATH: process.env.PATH` hands it the developer's real `codex`,
 * `claude` or `pi`: CI has none, so CI never sees it.
 *
 * Call `stubbedAgentClis()` once in a test file, below its cleanup hooks (a hook
 * that throws stops the ones registered after it, which would leave an Inbox
 * running), and spread its `env` where the child's PATH was. That PATH holds the stubs, `bun`, the `gh` tripwire
 * (it comes before a real /usr/bin/gh) and the system's own folders, never the folder bun is installed in: on
 * Homebrew that is where the agents are too. The env also gives the child the test sandbox,
 * which empties an Inbox's agent PATH, even in a run the preload missed.
 *
 * The stubs are the second wall: a test fails when one was called, because
 * without them that call would have run the real CLI. A test that means to
 * reach one takes its own calls with `takeCalls()`.
 */
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agentCliCalls, writeAgentCliStubs } from "../e2e/agent-cli-stubs";
import { GH_TRIPWIRE_BIN } from "../setup/gh-tripwire";

export interface StubbedAgentClis {
  /** Spread into a child's env in place of `PATH: process.env.PATH`. */
  env: { PATH: string; PLANNOTATOR_TEST_SANDBOX: string };
  /** The folder of stubs, first on `env.PATH`. */
  bin: string;
  /** The calls the stubs recorded since the last look, one `<name> <args>` each. */
  takeCalls(): string[];
}

export function stubbedAgentClis(): StubbedAgentClis {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-clis-")));
  const bin = writeAgentCliStubs(join(root, "bin"));
  symlinkSync(process.execPath, join(bin, "bun"));
  // The stubs are POSIX scripts; a Windows child keeps its PATH and has the sandbox alone.
  const system = process.platform === "win32" ? (process.env.PATH ?? "") : ["/usr/bin", "/bin"].join(delimiter);
  let seen = 0;
  const takeCalls = () => {
    const calls = agentCliCalls(bin);
    const fresh = calls.slice(seen);
    seen = calls.length;
    return fresh;
  };
  const failOnCalls = () => {
    const calls = takeCalls();
    if (calls.length > 0) {
      throw new Error(`A child process ran an agent CLI (a stub answered; without it the real CLI would have run):\n  ${calls.join("\n  ")}`);
    }
  };
  afterEach(failOnCalls);
  afterAll(() => {
    try {
      failOnCalls();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    env: { PATH: [bin, GH_TRIPWIRE_BIN, system].join(delimiter), PLANNOTATOR_TEST_SANDBOX: process.env.PLANNOTATOR_TEST_SANDBOX ?? root },
    bin,
    takeCalls,
  };
}
