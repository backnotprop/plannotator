import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { agentCliCalls, writeAgentCliStubs } from "../e2e/agent-cli-stubs";
import { GH_TRIPWIRE_BIN } from "../setup/gh-tripwire";

export interface StubbedAgentClis {
  env: { PATH: string; PLANNOTATOR_TEST_SANDBOX: string };
  bin: string;
  takeCalls(): string[];
}

export function stubbedAgentClis(): StubbedAgentClis {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-clis-")));
  const bin = writeAgentCliStubs(join(root, "bin"));
  symlinkSync(process.execPath, join(bin, "bun"));
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
