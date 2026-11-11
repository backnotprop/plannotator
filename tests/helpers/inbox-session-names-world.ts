/**
 * A scratch Inbox world for a thread's sessions by name (issue #3108, approval "inbox-thread-session-names"): one
 * thread three Claude Code sessions wrote in, each with its own title (the poll's `label`, as the Claude Code mod
 * sends it), one thread six sessions of five agents wrote in (one long title, one session that ended), and a thread
 * one session wrote in alone. Live sessions poll the bridge as the mod, Pi and OpenCode do. Used by the e2e spec
 * (inbox-thread-sessions.spec.ts) and by hand against a scratch build; never the person's Inbox: every caller passes
 * the scratch Inbox it started.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';

/** One live session: long-polls the bridge with its title and whether a turn runs. */
class LiveSession {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    private readonly base: string,
    private readonly token: string,
    readonly session: string,
    readonly host: string,
    private readonly projectPath: string,
    private readonly label: string,
    private readonly busy: boolean,
    private readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const ok = await fetch(`${this.base}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ session: this.session, host: this.host, label: this.label, waitMs: 1_000, project_path: this.projectPath, started_at: this.startedAt, busy: this.busy, idle_since: this.startedAt + 60_000 }),
      })
        .then((r) => r.text())
        .then(() => true)
        .catch(() => false);
      await new Promise((r) => setTimeout(r, ok ? 150 : 300));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

export const SESSION_NAMES = {
  billing: 'cc-billing-3c1f0a52',
  retry: 'cc-retry-8e44b1d0',
  ledger: 'cc-ledger-2a9f6c37',
  docs: 'cc-docs-71d0e5ab',
  codex: 'cx-search-5b2e9a10',
  pi: 'pi-infra-0c7d4e21',
  opencode: 'oc-site-9f13a6b4',
  /** Wrote once and never polls: ended. */
  cursor: 'cu-ended-4d82c9e7',
  /** Wrote alone in its own thread. */
  alone: 'cc-alone-6e0b3d58',
} as const;

export const LONG_TITLE = 'Migrate the payment webhooks to the new queue and backfill';

export interface SessionNamesWorld {
  /** Three Claude Code sessions. */
  three: string;
  /** Six sessions: Claude Code, Codex, Pi, OpenCode, Cursor (ended), Claude Code. */
  six: string;
  /** One session. */
  one: string;
  stop: () => Promise<void>;
}

export async function seedSessionNamesWorld(base: string, token: string, projectsDir: string): Promise<SessionNamesWorld> {
  let rpc = 1;
  const send = async (args: Record<string, unknown>): Promise<{ message_id: string; thread_id: string }> => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name: 'send_message', arguments: args, _meta: { 'ai.plannotator/inbox-wakes': true } } }),
    });
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    const json = JSON.parse(line ? line.slice(5) : text) as { error?: unknown; result?: { isError?: boolean; structuredContent: { message_id: string; thread_id: string } } };
    if (json.error || json.result?.isError) throw new Error(text);
    return json.result!.structuredContent;
  };
  const billing = join(projectsDir, 'billing-svc');
  const site = join(projectsDir, 'docs-site');
  for (const dir of [billing, site]) mkdirSync(dir, { recursive: true });
  const S = SESSION_NAMES;
  const now = Date.now();
  const live = [
    new LiveSession(base, token, S.billing, 'claude-code', billing, 'Billing refactor', false, now - 3 * 3600_000),
    new LiveSession(base, token, S.retry, 'claude-code', billing, 'Retry worker', true, now - 2 * 3600_000),
    new LiveSession(base, token, S.ledger, 'claude-code', billing, 'Ledger export', false, now - 3600_000),
    new LiveSession(base, token, S.docs, 'claude-code', site, LONG_TITLE, true, now - 5 * 3600_000),
    new LiveSession(base, token, S.codex, 'codex', site, 'Search index', false, now - 4 * 3600_000),
    new LiveSession(base, token, S.pi, 'pi', billing, 'Queue timeouts', true, now - 6 * 3600_000),
    new LiveSession(base, token, S.opencode, 'opencode', site, 'Docs nav', false, now - 7 * 3600_000),
    new LiveSession(base, token, S.alone, 'claude-code', billing, 'Rate limits', false, now - 3600_000),
  ];
  // The titles are heard before anything is written, so the window names each session from its first read.
  for (let i = 0; i < 100; i++) {
    const agents = (await (await fetch(`${base}/api/inbox/threads`)).json().catch(() => ({}))) as { agents?: { agents: { session: string }[] }[] };
    const seen = new Set((agents.agents ?? []).flatMap((g) => g.agents.map((a) => a.session)));
    if (live.every((l) => seen.has(l.session))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const cc = { agent_host: 'claude-code', agent_name: 'Claude Code' };

  const t3 = await send({ ...cc, agent_session: S.billing, project_path: billing, subject: 'Invoice retries', thread: 'Invoice retries', body: 'Retries are failing for card declines. Two causes so far.' });
  const b = await send({ ...cc, agent_session: S.retry, project_path: billing, reply_to: t3.message_id, body: 'It retries 4 times, backing off up to 6 hours, then gives up.' });
  const c = await send({ ...cc, agent_session: S.ledger, project_path: billing, reply_to: b.message_id, body: 'Ledger marks a retried charge as new: that is the double count.' });
  await send({ ...cc, agent_session: S.billing, project_path: billing, reply_to: c.message_id, body: 'Both fixes are ready.\n\n:::question\nRetry declined cards after 24 hours?\n\n- [ ] Yes\n- [ ] No\n:::' });

  const t6 = await send({ ...cc, agent_session: S.docs, project_path: site, subject: 'Search ranking for the docs site', thread: 'Docs search', body: 'Search ranks old pages first. I asked the others to look at their parts.' });
  let last = t6.message_id;
  for (const [session, host, name, body] of [
    [S.codex, 'codex', 'Codex', 'The index weights page age; I switched it to last edit.'],
    [S.pi, 'pi', 'Pi', 'The queue that rebuilds the index now runs every 10 minutes.'],
    [S.opencode, 'opencode', 'OpenCode', 'The nav links now point at the new pages.'],
    [S.cursor, 'cursor', 'Cursor', 'I checked the redirects: all 41 old paths land.'],
    [S.alone, 'claude-code', 'Claude Code', 'Rate limits are unchanged by this.'],
  ] as const) {
    last = (await send({ agent_host: host, agent_name: name, agent_session: session, project_path: host === 'pi' ? billing : site, reply_to: last, body })).message_id;
  }
  const t1 = await send({ ...cc, agent_session: S.alone, project_path: billing, subject: 'Rate limit headers', thread: 'Rate limits', body: 'The API now returns the rate limit headers.' });
  await send({ ...cc, agent_session: S.alone, project_path: billing, reply_to: t1.message_id, body: 'I added them to the docs too.' });

  return {
    three: t3.thread_id,
    six: t6.thread_id,
    one: t1.thread_id,
    stop: async () => {
      await Promise.all(live.map((l) => l.stop()));
    },
  };
}
