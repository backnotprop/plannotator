/**
 * Plannotator Inbox agent simulation: agents that write to the Inbox through
 * its real stdio entry, `plannotator inbox mcp`, driven by the MCP SDK's own
 * stdio client, and read the person's answers back. Each SimAgent is one
 * shim process, so one agent session (its own `ses_` id).
 *
 * Used by the window's browser proof (tests/e2e/inbox.spec.ts). Also runs by
 * hand against a compiled binary and a scratch data dir:
 *
 *   bun scripts/inbox-sim.ts --binary .local/plannotator --data-dir /tmp/inbox-demo
 *
 * which writes the demo threads into two scratch git projects under the data
 * dir's parent and prints their thread ids. `project_path` is always passed
 * explicitly: a host may run the shim from a folder that is not the project.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export interface SimAgentOptions {
  /** The compiled `plannotator` binary. */
  binary: string;
  /** The environment the shim runs with: PLANNOTATOR_DATA_DIR at least. */
  env: Record<string, string>;
  /** How the person sees the agent ("Claude Code"). */
  name: string;
  /** The agent host (`claude-code`, `pi`, `opencode`, `codex`). */
  host: string;
  /** The shim's working folder; never taken as the project. */
  cwd?: string;
}

type Structured = Record<string, any>;

export class SimAgent {
  private constructor(
    private readonly client: Client,
    readonly name: string,
    readonly host: string,
  ) {}

  static async connect(options: SimAgentOptions): Promise<SimAgent> {
    const client = new Client({ name: `inbox-sim-${options.host}`, version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: options.binary,
      args: ['inbox', 'mcp'],
      cwd: options.cwd ?? options.env.PLANNOTATOR_DATA_DIR,
      env: options.env,
      stderr: 'pipe',
    });
    await client.connect(transport);
    return new SimAgent(client, options.name, options.host);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<Structured> {
    const result = (await this.client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
      structuredContent?: Structured;
    };
    if (result.isError) throw new Error(`${name}: ${result.content?.map((c) => c.text).join(' ')}`);
    return result.structuredContent ?? {};
  }

  send(input: {
    project_path: string;
    body: string;
    subject?: string;
    thread?: string;
    reply_to?: string;
    idempotency_key?: string;
    /** Files to attach: absolute, or relative to project_path. */
    attachments?: string[];
  }): Promise<Structured> {
    return this.call('send_message', { ...input, agent_name: this.name, agent_host: this.host });
  }

  /** The thread as the agent reads it (this also tells the Inbox the agent has read the person's reply). */
  async readThread(threadId: string): Promise<Structured> {
    return (await this.call('read_thread', { thread_id: threadId })).thread as Structured;
  }

  waitForReply(threadId: string, timeoutSeconds = 50): Promise<Structured> {
    return this.call('wait_for_reply', { thread_id: threadId, timeout_seconds: timeoutSeconds });
  }

  /** The project's decisions as an agent reads them (`state`: current by default, or replaced, retired, all). */
  async listDecisions(projectPath: string, state?: 'current' | 'replaced' | 'retired' | 'all'): Promise<Structured[]> {
    return (await this.call('list_decisions', { project_path: projectPath, ...(state ? { state } : {}) })).decisions as Structured[];
  }

  /** An agent records a decision it settled with the person. */
  recordDecision(input: { project_path: string; text: string; reason?: string; idempotency_key?: string }): Promise<Structured> {
    return this.call('record_decision', { ...input, agent_name: this.name, agent_host: this.host });
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

/** The demo messages: one per section the record draws first. */
export const DEMO_MESSAGES = {
  /** Stopped on you: two questions, one records a decision, one holds up two pieces of work. */
  stopped: [
    'I checked the 409 row against the Stripe docs. Two things before I go on.',
    '',
    ':::question',
    'Which way should the worker go on a Stripe 409?',
    'Decision: when answered',
    'Stopped: the retry worker cannot ship without this.',
    '',
    '- [ ] Retry with the same idempotency key',
    '- [ ] Fail the job and send it to the dead-letter queue',
    'Recommended: Retry with the same idempotency key',
    ':::',
    '',
    ':::question',
    'Ship the retry worker behind a flag?',
    'Holds up: the retry worker; the admin retry view.',
    '',
    '- [ ] Yes',
    '- [ ] No',
    'Recommended: Yes',
    ':::',
  ].join('\n'),
  /** Holding up work: three pieces of work wait on one answer. */
  holding: [
    'The install page can detect what is on the machine. One call before I build it.',
    '',
    ':::question',
    'Detect the installed agents, or ask the reader to pick?',
    'Holds up: the install page; the agent table; the screenshots.',
    '',
    '- [ ] Detect, and ask only when two are installed',
    '- [ ] Always ask',
    'Recommended: Detect, and ask only when two are installed',
    ':::',
  ].join('\n'),
  /** Waiting on you, in a thread the agent named. */
  named: [
    'Refunds can come from the webhook or from polling Stripe.',
    '',
    ':::question',
    'Refund events: trust the webhook or poll Stripe?',
    '',
    '- [ ] Trust the webhook',
    '- [ ] Poll Stripe every minute',
    ':::',
  ].join('\n'),
  /** News with no question: New since you looked. */
  news: 'Run finished. The install page builds and its links check out.',
};

/** A scratch git repository named `name` under `parent`, as an agent's project. */
export function scratchProject(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return realpathSync(dir);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const binary = resolve(flag('--binary') ?? '.local/plannotator');
  const dataDir = resolve(flag('--data-dir') ?? '');
  if (!flag('--data-dir')) {
    process.stderr.write('Usage: bun scripts/inbox-sim.ts --binary <plannotator> --data-dir <scratch data dir>\n');
    process.exit(2);
  }
  mkdirSync(dataDir, { recursive: true });
  const src = join(dirname(dataDir), 'src');
  const billing = scratchProject(src, 'billing-svc');
  const docs = scratchProject(src, 'docs-site');
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dataDir, PLANNOTATOR_DATA_DIR: dataDir };
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const claude2 = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  try {
    const a = await claude.send({ project_path: billing, body: DEMO_MESSAGES.stopped });
    const b = await opencode.send({ project_path: docs, body: DEMO_MESSAGES.holding });
    const c = await claude2.send({ project_path: billing, body: DEMO_MESSAGES.named, thread: 'refund-webhooks' });
    process.stdout.write(`${JSON.stringify({ stopped: a.thread_id, holding: b.thread_id, named: c.thread_id, url: a.url }, null, 2)}\n`);
  } finally {
    await Promise.all([claude.close(), opencode.close(), claude2.close()]);
  }
}

// A run by hand under Bun; imported (the browser proof), it does nothing.
if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' && process.argv[1] && /inbox-sim\.ts$/.test(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
