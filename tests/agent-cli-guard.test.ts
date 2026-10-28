/**
 * The e2e agent CLI guard (tests/helpers/agent-cli-guard.ts): it covers every
 * command the ACP runner can start, its stand-in answers `--version` the way
 * the runner reads as "not this agent", and any other call trips it.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_RUN_AGENTS } from "../packages/server/inbox-acp-runner";
import { RUNNER_AGENT_COMMANDS, agentCliGuardedPath, agentCliTripwireCalls, installAgentCliGuard } from "./helpers/agent-cli-guard";

describe("agent CLI guard", () => {
  test("stands in for every command the runner can start", () => {
    for (const agent of INBOX_RUN_AGENTS) expect(RUNNER_AGENT_COMMANDS as readonly string[]).toContain(agent.descriptor.command);
  });

  test("first on PATH; --version is no agent's answer and is not a trip; any other call is logged and refused", () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-agent-cli-guard-test-"));
    try {
      const bin = join(root, "bin");
      const log = join(root, "tripwire.log");
      installAgentCliGuard(bin, log);
      const env = { PATH: agentCliGuardedPath(bin, process.env.PATH) };
      for (const name of RUNNER_AGENT_COMMANDS) {
        expect(spawnSync("sh", ["-c", `command -v ${name}`], { env, encoding: "utf8" }).stdout.trim()).toBe(join(bin, name));
        const version = spawnSync(name, ["--version"], { env, encoding: "utf8" });
        expect(version.status).toBe(1);
        const shape = INBOX_RUN_AGENTS.find((a) => a.descriptor.command === name)?.descriptor.versionShape;
        if (shape) expect(shape.test(version.stdout.trim())).toBe(false);
        expect(agentCliTripwireCalls(log)).toEqual([]);
        const run = spawnSync(name, ["agent", "stdio"], { env, encoding: "utf8" });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("TRIPWIRE");
      }
      expect(agentCliTripwireCalls(log)).toEqual(RUNNER_AGENT_COMMANDS.map((name) => `${name} agent stdio`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
