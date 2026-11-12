import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const AGENT_CLIS = [
  'claude', 'codex', 'gemini', 'opencode', 'opencode2', 'pi', 'omp', 'amp', 'cline', 'cursor', 'cursor-agent', 'agent', 'devin', 'kiro-cli', 'copilot', 'droid', 'code', 'qwen', 'dsh',
  'openclaude', 'autohand', 'agy', 'aider', 'goose', 'kilo', 'crush', 'auggie', 'codebuff', 'command-code', 'cn', 'kimi', 'vibe', 'qwen-code', 'rovo', 'hermes', 'openclaw', 'grok',
  'cswap',
] as const;

export const AGENT_CLI_STUBS_ENV = 'PLANNOTATOR_E2E_AGENT_CLI_STUBS';

const LOG = 'calls.log';

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

export function agentCliCalls(dir: string): string[] {
  const file = join(dir, LOG);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

export default async function guardAgentClis(): Promise<() => Promise<void>> {
  const existing = process.env[AGENT_CLI_STUBS_ENV];
  if (existing && (process.env.PATH ?? '').split(delimiter)[0] === existing) return async () => {};
  const dir = writeAgentCliStubs(realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-e2e-agent-clis-'))));
  process.env.PATH = [dir, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  process.env[AGENT_CLI_STUBS_ENV] = dir;
  return async () => {
    const calls = agentCliCalls(dir).filter((call) => call !== 'cswap list --json');
    rmSync(join(dir, LOG), { force: true });
    if (calls.length > 0) {
      throw new Error(
        `An e2e spec ran an agent CLI through the runner's PATH (a stub answered; without it the real CLI would have run):\n  ${calls.join('\n  ')}\n` +
          'Give that Inbox PLANNOTATOR_TEST_SANDBOX and a PATH of its own (see tests/e2e/agent-cli-stubs.ts).',
      );
    }
  };
}
