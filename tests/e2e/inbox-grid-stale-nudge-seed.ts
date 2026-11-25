/**
 * Made-up work for tests/e2e/inbox-grid-stale-nudge.spec.ts, written into an Inbox's event log at times in the past
 * (the store's clock is injected), before that Inbox starts. Run with bun:
 *
 *   bun tests/e2e/inbox-grid-stale-nudge-seed.ts <data dir> <projects dir> <studio|mini>
 *   bun tests/e2e/inbox-grid-stale-nudge-seed.ts <data dir> <projects dir> move <thread id>
 *
 * The times are counted back from `GRID_SEED_NOW` (ms; the spec gives both computers the one it freezes its browser
 * near), else now. `move`, run while that Inbox is stopped: the thread's agent sets its steps now, so its work moved.
 *
 * Studio: harbor's Pagination cursors asks the person (Needs you); Rate limit the export (#418, tests running) and
 * fern-api's Webhook retries are Moving; quill-docs' Search index rebuild is Not moving; fern-api's Nightly summary
 * (#7, a draft) has been quiet 3 h 10 min and a quill-docs plan was never started 14 h on (both Stale); Ledger CSV export
 * (#402) merged 41 min ago. Mini: ledger's Haptics on save (#22, tests failing) has been quiet 3 h 37 min and Offline
 * sync 3 h 20 min (both Stale), and Reconcile cron is Moving.
 *
 * Each agent session is its own (`ses_…`); the spec keeps them connected, so their agents are still there, and names
 * them (tide-ios, wrangler, …) in `inbox/agent-faces.json`, as Rename… would. The PRs' states are the forge fixture's
 * (`PLANNOTATOR_TEST_FORGE_STATES`), written beside the data dir as `forge.json`. Prints
 * `{ threads: { <name>: <thread id> }, quiet: { <name>: <ISO time its quiet stretch began> }, agents: { <session>: <name> } }`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { InboxStore } from '../../packages/shared/inbox/store';
import { parseInboxThreadPullRef } from '../../packages/core/inbox-thread-pulls';

const [dataDir, src, computer, movedThread] = process.argv.slice(2);
if (!dataDir || !src || (computer !== 'studio' && computer !== 'mini' && !(computer === 'move' && movedThread))) {
  throw new Error('usage: inbox-grid-stale-nudge-seed.ts <data dir> <projects dir> <studio|mini|move <thread id>>');
}

if (computer === 'move') {
  const moving = InboxStore.open(dataDir);
  const by = moving.thread(movedThread!)!.messages.find((m) => m.author.kind === 'agent')!.author;
  moving.setThreadSteps({ thread_id: movedThread!, agent: by, steps: [{ step: 'Retry the sync on reconnect', status: 'doing' }] });
  process.exit(0);
}

const NOW = Number(process.env.GRID_SEED_NOW) || Date.now();
let at = NOW;
const store = InboxStore.open(dataDir, { now: () => new Date(at) });
const ago = (minutes: number) => NOW - minutes * 60_000;

type Agent = { kind: 'agent'; host: string; session: string; name: string | null };
const agents: Record<string, string> = {};
const agent = (session: string, name: string): Agent => {
  agents[session] = name;
  return { kind: 'agent', host: 'claude-code', session, name: null };
};
const project = (name: string) => {
  const root = join(src, name);
  mkdirSync(root, { recursive: true });
  return store.ensureProject({ name, root });
};

const threads: Record<string, string> = {};
const quiet: Record<string, string> = {};

/** A thread by one agent: its messages at these minutes ago (the last one's words given or a plain update). */
function work(p: { id: string }, who: Agent, name: string, minutes: number[], last?: string): { thread: string; last: string } {
  let reply: string | null = null;
  let thread = '';
  minutes.forEach((m, i) => {
    at = ago(m);
    const body = i === minutes.length - 1 && last ? last : i === 0 ? `Starting on ${name.toLowerCase()}.` : 'Pushed the next part.';
    const sent = store.sendMessage({ project_id: p.id, author: who, body, ...(reply ? { reply_to: reply } : { thread: name }) }).message;
    reply = sent.id;
    thread = sent.thread_id;
  });
  threads[name] = thread;
  quiet[name] = new Date(ago(minutes.at(-1)!)).toISOString();
  return { thread, last: reply! };
}

const forge: Record<string, Record<string, unknown>> = {};
/** A PR put on a thread at a minute ago, its state then, and what the forge says of it now. */
function pull(thread: string, ref: string, by: Agent, addedAgo: number, now: { state: 'open' | 'draft' | 'merged'; checks?: string; readAgo?: number }) {
  const parsed = parseInboxThreadPullRef(ref, 'github.com');
  if ('error' in parsed) throw new Error(parsed.error);
  at = ago(addedAgo);
  store.changeThreadPulls({ thread_id: thread, add: [parsed], by: { kind: 'agent', session: by.session, host: by.host, name: by.name } });
  at = ago(now.readAgo ?? addedAgo - 1);
  store.setThreadPullState(thread, parsed.key, { state: now.state, title: null, base: 'main', head: 'work' });
  forge[ref] = { state: now.state, ...(now.checks ? { checks: now.checks } : {}) };
}

if (computer === 'studio') {
  const harbor = project('harbor');
  const fern = project('fern-api');
  const quill = project('quill-docs');
  const ops = agent('ses_harbor_ops', 'harbor-ops');
  work(harbor, ops, 'Pagination cursors', [130, 60], ['Charlie Dunn wants the cursor API out this week.', '', ':::question', 'Keep the old page param?', '', '- [ ] Keep it for a release', '- [ ] Drop it now', ':::'].join('\n'));
  const rate = work(harbor, ops, 'Rate limit the export', [150, 70, 3]);
  pull(rate.thread, 'acme/harbor#418', ops, 45, { state: 'open', checks: 'running' });
  const csv = work(harbor, agent('ses_harbor_csv', 'harbor-csv'), 'Ledger CSV export', [300, 120, 41], 'Merged; Bob Tully has the release note.');
  pull(csv.thread, 'acme/harbor#402', agent('ses_harbor_csv', 'harbor-csv'), 110, { state: 'merged', readAgo: 41 });
  work(fern, agent('ses_fern_hooks', 'fern-hooks'), 'Webhook retries', [95, 30, 6]);
  work(quill, agent('ses_quill_index', 'quill-index'), 'Search index rebuild', [140, 50]);
  const nightlyBy = agent('ses_wrangler', 'wrangler');
  const nightly = work(fern, nightlyBy, 'Nightly summary', [300, 250, 190]);
  pull(nightly.thread, 'acme/fern-api#7', nightlyBy, 240, { state: 'draft' });
  // A plan Bob Tully wrote 14 h ago that its agent never started.
  at = ago(14 * 60 + 10);
  const plan = store.startPersonThread({ project_id: quill.id, body: 'Plan: move the docs theme to the new tokens. Bob Tully signed off on the palette.', to: { host: 'claude-code', session: 'ses_quill_theme' }, idempotency_key: 'grid-plan-theme' });
  agents.ses_quill_theme = 'quill-theme';
  threads['Plan: move the docs theme to the new tokens'] = plan.message.thread_id;
} else {
  const ledger = project('ledger');
  const tide = agent('ses_tide_ios', 'tide-ios');
  const haptics = work(ledger, tide, 'Haptics on save', [330, 260, 217], 'One test fails on the simulator; looking.');
  pull(haptics.thread, 'acme/ledger#22', tide, 280, { state: 'open', checks: 'failing' });
  work(ledger, agent('ses_tide_sync', 'tide-sync'), 'Offline sync', [320, 200]);
  work(ledger, agent('ses_ledger_cron', 'ledger-cron'), 'Reconcile cron', [80, 12, 2]);
}
at = NOW;

writeFileSync(join(dirname(dataDir), 'forge.json'), JSON.stringify(forge, null, 2));
// The agents' names, as Rename… on their sidebar rows keeps them.
const faces = Object.fromEntries(Object.entries(agents).map(([session, name]) => [session, { face: 'agent', sessions: [], name }]));
mkdirSync(join(dataDir, 'inbox'), { recursive: true });
writeFileSync(join(dataDir, 'inbox', 'agent-faces.json'), JSON.stringify({ v: 1, rev: 1, faces }));
console.log(JSON.stringify({ threads, quiet, agents }));
