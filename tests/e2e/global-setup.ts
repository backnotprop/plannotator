/**
 * Before any spec: the agent CLI guard (tests/helpers/agent-cli-guard.ts)
 * goes first on PATH, so every spec, and every binary a spec starts with
 * `process.env.PATH`, finds a stand-in for each agent the Inbox runs itself,
 * never the real CLI. Playwright hands this process.env to its workers.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CLI_TRIPWIRE_LOG_ENV, RUNNER_AGENT_COMMANDS, agentCliGuardedPath, installAgentCliGuard } from '../helpers/agent-cli-guard';

export default function globalSetup(): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-e2e-agent-cli-guard-')));
  const bin = join(root, 'bin');
  const log = join(root, 'tripwire.log');
  installAgentCliGuard(bin, log);
  process.env.PATH = agentCliGuardedPath(bin, process.env.PATH);
  process.env[AGENT_CLI_TRIPWIRE_LOG_ENV] = log;
  // Never the live feedback Worker (its table is append-only): every spec and every binary started
  // with this env sends feedback to a closed loopback port (tests/setup/feedback-archive-off.ts).
  process.env.PLANNOTATOR_FEEDBACK_URL = 'http://127.0.0.1:9/feedback';
  // The guard is what the PATH finds, or the run does not start.
  for (const name of RUNNER_AGENT_COMMANDS) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { env: process.env, encoding: 'utf8' }).stdout.trim();
    if (found !== join(bin, name)) throw new Error(`agent CLI guard: \`${name}\` resolves to ${found || 'nothing'}, not the stand-in in ${bin}`);
  }
}
