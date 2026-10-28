/**
 * The e2e runs never reach a real agent CLI that the Inbox runs itself.
 *
 * The ACP runner (packages/server/inbox-acp-runner.ts) looks its agents up on
 * the Inbox's PATH and runs `<command> --version` to check one, whenever the
 * window asks what New message can start (compose, Settings → Agents). The
 * Inbox specs pass `process.env.PATH` to the binary, so on a developer's
 * computer with Grok Build installed that was the real `grok`.
 *
 * `installAgentCliGuard` writes a stand-in for every command the runner can
 * start (`RUNNER_AGENT_COMMANDS`) into a scratch folder that goes first on
 * PATH (tests/e2e/global-setup.ts, for every spec and every binary it
 * starts). A stand-in answers `--version` with a line no agent prints and
 * exits 1, so the runner reads the agent as not this one and offers nothing,
 * as on a computer without it. Any other call is the tripwire: it is logged
 * and refused, and tests/e2e/global-teardown.ts fails the run naming it.
 *
 * Specs that build PATH from scratch (tests/helpers/fake-agents.ts: a bin of
 * fakes, then /usr/bin:/bin) hold no real agent CLI and need no guard.
 *
 * Node-safe (no Bun APIs): Playwright's global setup runs it under node.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Every command the ACP runner can start (INBOX_RUN_AGENTS' descriptors).
 * tests/agent-cli-guard.test.ts fails when the runner gains one this list lacks.
 */
export const RUNNER_AGENT_COMMANDS = ["grok"] as const;

/** The env var that names the tripwire log for the run (set by the global setup). */
export const AGENT_CLI_TRIPWIRE_LOG_ENV = "PLANNOTATOR_E2E_AGENT_CLI_TRIPWIRE_LOG";

/** What a stand-in prints for `--version`: no agent's version shape matches it. */
export const AGENT_CLI_STUB_VERSION = "plannotator e2e stand-in, not an agent";

function stub(name: string, log: string): string {
  const quotedLog = `'${log.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    `# A stand-in for ${name} in the e2e runs (tests/helpers/agent-cli-guard.ts). Never the real CLI.`,
    'if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then',
    `  echo "${AGENT_CLI_STUB_VERSION}"`,
    "  exit 1",
    "fi",
    `printf '%s\\n' "${name} $*" >> ${quotedLog}`,
    `echo "TRIPWIRE: a test ran ${name} $* (tests/helpers/agent-cli-guard.ts). Tests never run a real agent CLI: use the fake ACP agent." >&2`,
    "exit 1",
    "",
  ].join("\n");
}

/** Writes the stand-ins into `dir` (made if missing); calls past `--version` are appended to `log`. */
export function installAgentCliGuard(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(log)) writeFileSync(log, "");
  for (const name of RUNNER_AGENT_COMMANDS) {
    const path = join(dir, name);
    writeFileSync(path, stub(name, log));
    chmodSync(path, 0o755);
  }
}

/** `path` with the guard's folder first. */
export function agentCliGuardedPath(dir: string, path: string | undefined): string {
  return path ? `${dir}${delimiter}${path}` : dir;
}

/** The tripwire's calls (one line each: the command and its arguments); none when the log is missing. */
export function agentCliTripwireCalls(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((line) => line.trim() !== "");
}
