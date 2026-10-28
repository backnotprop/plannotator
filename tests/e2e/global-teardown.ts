/**
 * After every spec: any call that reached an agent CLI stand-in past its
 * `--version` answer (tests/helpers/agent-cli-guard.ts) fails the run, named,
 * so a spec that would have run a real agent CLI never passes quietly.
 */
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { AGENT_CLI_TRIPWIRE_LOG_ENV, agentCliTripwireCalls } from '../helpers/agent-cli-guard';

export default function globalTeardown(): void {
  const log = process.env[AGENT_CLI_TRIPWIRE_LOG_ENV];
  if (!log) return;
  const calls = agentCliTripwireCalls(log);
  rmSync(dirname(log), { recursive: true, force: true });
  if (calls.length > 0) {
    throw new Error(`agent CLI tripwire: a spec ran an agent CLI past --version (tests never run a real agent CLI):\n${calls.map((c) => `  ${c}`).join('\n')}`);
  }
}
