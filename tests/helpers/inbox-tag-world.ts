import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands, type InboxReplyCommand } from '../../packages/shared/inbox/connection';

export const TAG_SESSIONS = {
  owner: 'cc-owner-6f2c9e14',
  claudeTwo: 'cc-two-91b0d3aa',
  claudeElsewhere: 'cc-plan-44e1c7f0',
  pi: 'pi-0193',
  opencode: 'ses_oc_7d21',
  oldPi: 'pi-old-55aa',
  codex: 'ses_docs_codex',
} as const;

export interface TagWorld {
  base: string;
  projects: { billing: string; infra: string; plannotator: string; docs: string };
  ids: { t1: string; t1msg: string; t2: string; r2: string; t3: string; r3: string; p3: string };
  connections: TagConnection[];
  stop: () => Promise<void>;
}

export class TagConnection {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    private readonly base: string,
    private readonly token: string,
    readonly session: string,
    readonly host: string,
    private readonly projectPath: string,
    private readonly state: { busy: boolean; tags: boolean; sendNow: boolean; startedAt: number },
  ) {
    this.loop = this.run();
  }

  private bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ session: this.session, host: this.host, ...body }),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
        waitMs: 1_000,
        project_path: this.projectPath,
        started_at: this.state.startedAt,
        busy: this.state.busy,
        idle_since: this.state.startedAt + 60_000,
        ...(this.state.sendNow ? { send_now: true } : {}),
        ...(this.state.tags ? { tags: true } : {}),
      }).catch(() => null);
      if (!response) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      for (const command of parseInboxBridgeCommands(await response.text().catch(() => '{}'))) {
        const known = this.commands.findIndex((c) => c.id === command.id);
        if (known < 0) this.commands.push(command);
        else this.commands[known] = command;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async deliver(id: string): Promise<number> {
    return (await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })).status;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

export async function seedTagWorld(base: string, token: string, projectsDir: string, options: { connections?: boolean } = {}): Promise<TagWorld> {
  let rpc = 1;
  const send = async (args: Record<string, unknown>, wakes = true): Promise<{ message_id: string; thread_id: string }> => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpc++,
        method: 'tools/call',
        params: { name: 'send_message', arguments: args, ...(wakes ? { _meta: { 'ai.plannotator/inbox-wakes': true } } : {}) },
      }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    const json = JSON.parse(line ? line.slice(5) : text) as { error?: unknown; result?: { isError?: boolean; structuredContent: { message_id: string; thread_id: string } } };
    if (json.error || json.result?.isError) throw new Error(text);
    return json.result!.structuredContent;
  };
  const post = async (path: string, body: unknown = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (r.status >= 400) throw new Error(`${path} ${r.status} ${JSON.stringify(json)}`);
    return json as { reply: { id: string } };
  };

  const billing = join(projectsDir, 'billing-api');
  const infra = join(projectsDir, 'infra');
  const plannotator = join(projectsDir, 'plannotator');
  const docs = join(projectsDir, 'docs-site');
  for (const dir of [billing, infra, plannotator, docs]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(billing, 'retry-design.md'),
    [
      '# Retry design for the Stripe webhook',
      '',
      '## Where retries live',
      '',
      'The handler acks Stripe within 2 s and hands the event to the `ledger-writes` queue. The queue owns retries.',
      '',
      '## Limits',
      '',
      '- At most 5 tries, backoff 2 s, 10 s, 60 s, 5 min, 30 min.',
      '- After the fifth failure the event goes to the dead-letter queue and pages on-call.',
      '',
      '## Open',
      '',
      'The visibility timeout is set in `infra/queue.tf`, which another session owns.',
    ].join('\n'),
  );
  const S = TAG_SESSIONS;
  const cc = { agent_host: 'claude-code', agent_name: 'Claude Code' };
  const now = Date.now();
  const connections: TagConnection[] = [];
  const connect = (session: string, host: string, project: string, state: Partial<{ busy: boolean; tags: boolean; sendNow: boolean; startedAt: number }> = {}) => {
    const connection = new TagConnection(base, token, session, host, project, { busy: false, tags: true, sendNow: true, startedAt: now - 3 * 3600_000, ...state });
    connections.push(connection);
    return connection;
  };
  if (options.connections !== false) {
    connect(S.owner, 'claude-code', billing, { busy: true, startedAt: now - 4 * 3600_000 });
    connect(S.claudeTwo, 'claude-code', billing, { startedAt: now - 2 * 3600_000 });
    connect(S.claudeElsewhere, 'claude-code', plannotator, { startedAt: now - 26 * 3600_000 });
    connect(S.pi, 'pi', infra, { busy: true, startedAt: now - 5 * 3600_000 });
    connect(S.opencode, 'opencode', plannotator, { busy: true, startedAt: now - 7 * 3600_000 });
    connect(S.oldPi, 'pi', infra, { tags: false, sendNow: false, startedAt: now - 6 * 3600_000 });
  }
  await send({ agent_host: 'codex', agent_name: 'Codex', project_path: docs, agent_session: S.codex, subject: 'Install page moved under /docs/install', body: 'The install page lives under /docs/install now; the old path redirects.' }, false);

  const t1 = await send({
    ...cc,
    project_path: billing,
    agent_session: S.owner,
    subject: 'Retry policy for the Stripe webhook',
    thread: 'Stripe retries',
    attachments: ['retry-design.md'],
    body: [
      'The webhook handler drops events when the ledger write times out. I wrote down a queue-owned retry in [retry-design.md](retry-design.md).',
      '',
      ':::question',
      'Should the queue own retries, with a dead-letter after 5 tries?',
      '',
      'Recommended: Yes, the queue',
      '',
      '- [ ] Yes, the queue',
      '- [ ] No, retry in the handler',
      ':::',
    ].join('\n'),
  });
  if (options.connections !== false) {
    for (let i = 0; i < 100; i++) {
      const res = (await (await fetch(`${base}/api/inbox/threads/${t1.thread_id}/taggable`)).json()) as { sessions: { session: string }[] };
      if (res.sessions.filter((s) => connections.some((c) => c.session === s.session)).length === connections.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const t2 = await send({
    ...cc,
    project_path: billing,
    agent_session: S.owner,
    subject: 'Dead-letter queue for ledger writes',
    thread: 'Dead-letter queue',
    body: 'The dead-letter queue is in place behind a flag. Before I turn it on, the queue\'s visibility timeout has to be longer than the slowest ledger write, and that lives in infra/queue.tf.',
  });
  const r2 = await post(`/api/inbox/messages/${t2.message_id}/reply`, {
    idempotency_key: 'tag-2',
    words: 'Turn it on once the timeout is fixed. @Pi please raise the visibility timeout in infra/queue.tf to 30 s and reply here. @Codex FYI, the runbook in docs-site needs the new dead-letter alert.',
    tags: options.connections === false ? [] : [{ session: S.pi, label: 'Pi' }, { session: S.codex, label: 'Codex' }],
  });
  const t3 = await send({
    ...cc,
    project_path: billing,
    agent_session: S.owner,
    subject: 'Ledger write timeout under load',
    thread: 'Ledger timeout',
    body: 'Under the load test, 2% of ledger writes time out at 4 s. The queue gives up before the write lands, so the event is retried while the first write still commits.',
  });
  const r3 = await post(`/api/inbox/messages/${t3.message_id}/reply`, {
    idempotency_key: 'tag-3',
    words: '@Pi you own the queue: can the visibility timeout go to 30 s without slowing the other consumers?',
    tags: options.connections === false ? [] : [{ session: S.pi, label: 'Pi' }],
  });
  const p3 = await send({
    agent_host: 'pi',
    agent_name: 'Pi',
    project_path: infra,
    agent_session: S.pi,
    reply_to: r3.reply.id,
    body: 'Yes. Only `ledger-writes` uses that queue, so 30 s affects nothing else. I raised it in infra/queue.tf and applied it to staging; production goes out with tonight\'s infra release.',
  });
  await send({
    ...cc,
    project_path: billing,
    agent_session: S.owner,
    reply_to: p3.message_id,
    body: 'Thanks. With 30 s I re-ran the load test: no duplicate commits in 20,000 events. I\'ll turn on the dead-letter queue after tonight\'s infra release.',
  });
  await send({
    agent_host: 'opencode',
    agent_name: 'OpenCode',
    project_path: plannotator,
    agent_session: S.opencode,
    subject: 'Search: rank archived threads below open ones',
    body: 'Archived threads now rank below open ones at the same match tier. The tests pass; I\'m moving on to the snippet cut.',
  });
  await send({
    agent_host: 'pi',
    agent_name: 'Pi',
    project_path: infra,
    agent_session: S.pi,
    subject: 'Staging certs renew on Friday',
    body: ':::question\nRenew the staging certs on Friday at 9:00, or now?\n\n- [ ] Friday at 9:00\n- [ ] Now\n:::',
  });
  return {
    base,
    projects: { billing, infra, plannotator, docs },
    ids: { t1: t1.thread_id, t1msg: t1.message_id, t2: t2.thread_id, r2: r2.reply.id, t3: t3.thread_id, r3: r3.reply.id, p3: p3.message_id },
    connections,
    stop: async () => {
      await Promise.all(connections.map((c) => c.stop()));
    },
  };
}
