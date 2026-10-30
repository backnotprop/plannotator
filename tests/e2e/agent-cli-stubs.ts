/**
 * Stand-ins for the agent CLIs (codex, claude, gemini, ...) so no e2e spec
 * ever runs a real one. Most specs start the Inbox with the runner's own PATH
 * (`PATH: process.env.PATH`), and the Inbox looks agents up on that PATH: the
 * Codex wake (packages/server/inbox-codex-wake.ts) runs `codex --version`
 * and then `codex queue` when a person answers a Codex session that sent with
 * a wake. On a computer with Codex installed that was the real Codex
 * (inbox-decision-mode.spec.ts did it); CI has no agents, so CI never saw it.
 *
 * Two uses:
 *
 *  - The Playwright global setup: tests/e2e/global-setup.ts runs it for
 *    playwright.config.ts, and the thread parity config names it as its
 *    `globalSetup`. One folder of stubs first on the runner's PATH,
 *    which every worker inherits, so a spec that passes the runner's PATH on
 *    finds a stub before any real agent CLI. When the run ends, any stub that
 *    was called fails the run: a spec reached for an agent CLI and would have
 *    run the real one without this folder. A spec that builds its own PATH
 *    gets none of this: it gives its Inbox PLANNOTATOR_TEST_SANDBOX (no agent
 *    lookups at all), or fakes of its own and no system folder that holds
 *    agents (tests/agent-cli-stubs.test.ts checks).
 *  - `writeAgentCliStubs(dir)` in a spec that wants its own record (put the
 *    folder first on the PATH it gives the Inbox, then assert
 *    `agentCliCalls(dir)` is empty).
 *
 * Each stub appends `<name> <args>` to `calls.log` in its folder and exits
 * 127 with nothing on stdout: no version, so nothing reads it as a usable CLI.
 * Node-safe (the specs run under node). POSIX only, like the specs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * Every agent CLI a Plannotator server looks up on PATH or spawns: the Inbox's agents (inbox-agents.ts
 * AGENT_SPECS) and Codex wake, the review servers' AI engines (ai-runtime.ts, review.ts, agent-jobs.ts,
 * marker-review.ts MARKER_ENGINES, `agent` being Cursor's other name), uninstall's plugin removals
 * (uninstall.ts, `code` being VS Code's), and the agent terminal's BUILT_IN_AGENTS
 * (@plannotator/webtui/core). tests/agent-cli-stubs.test.ts fails when one of those gains a name
 * missing here.
 */
export const AGENT_CLIS = [
  // The Inbox's agents, the review engines and uninstall.
  'claude', 'codex', 'gemini', 'opencode', 'opencode2', 'pi', 'omp', 'amp', 'cline', 'cursor', 'cursor-agent', 'agent', 'devin', 'kiro-cli', 'copilot', 'droid', 'code', 'qwen',
  // The agent terminal's built-in agents not listed above.
  'openclaude', 'autohand', 'agy', 'aider', 'goose', 'kilo', 'crush', 'auggie', 'codebuff', 'command-code', 'cn', 'kimi', 'vibe', 'qwen-code', 'rovo', 'hermes', 'openclaw', 'grok',
] as const;

/** Marks the runner's PATH as already guarded (the folder), so a second config load adds nothing. */
export const AGENT_CLI_STUBS_ENV = 'PLANNOTATOR_E2E_AGENT_CLI_STUBS';

const LOG = 'calls.log';

/** Write a recording stub for every agent CLI into `dir` (made if missing). Returns `dir`. */
export function writeAgentCliStubs(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const log = JSON.stringify(join(dir, LOG));
  for (const name of AGENT_CLIS) {
    const file = join(dir, name);
    writeFileSync(
      file,
      [
        '#!/bin/sh',
        `printf '%s\\n' "${name} $*" >> ${log}`,
        `echo "${name}: a stub from tests/e2e/agent-cli-stubs.ts; tests never run a real agent CLI" >&2`,
        'exit 127',
        '',
      ].join('\n'),
    );
    chmodSync(file, 0o755);
  }
  return dir;
}

/** Every call a stub in `dir` recorded, one `<name> <args>` line each. */
export function agentCliCalls(dir: string): string[] {
  const file = join(dir, LOG);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

/** Playwright globalSetup: stubs first on the runner's PATH; the returned teardown fails the run if any was called. */
export default async function guardAgentClis(): Promise<() => Promise<void>> {
  const existing = process.env[AGENT_CLI_STUBS_ENV];
  if (existing && (process.env.PATH ?? '').split(delimiter)[0] === existing) return async () => {};
  const dir = writeAgentCliStubs(realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-e2e-agent-clis-'))));
  process.env.PATH = [dir, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  process.env[AGENT_CLI_STUBS_ENV] = dir;
  return async () => {
    const calls = agentCliCalls(dir);
    // Only the log goes: the stubs stay (in the OS temp dir), so an Inbox a crashed spec left running still finds a stub.
    rmSync(join(dir, LOG), { force: true });
    if (calls.length > 0) {
      throw new Error(
        `An e2e spec ran an agent CLI through the runner's PATH (a stub answered; without it the real CLI would have run):\n  ${calls.join('\n  ')}\n` +
          'Give that Inbox PLANNOTATOR_TEST_SANDBOX and a PATH of its own (see tests/e2e/agent-cli-stubs.ts).',
      );
    }
  };
}
