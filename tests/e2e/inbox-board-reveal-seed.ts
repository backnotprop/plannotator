/**
 * The event log of an Inbox used for a few days, for tests/e2e/inbox-board-reveal.spec.ts (run with bun, before the
 * Inbox starts):
 *
 *   bun tests/e2e/inbox-board-reveal-seed.ts <data dir> <projects dir> <days ago>
 *
 * Six threads agents started `<days ago>` days back, an hour apart, in three projects, each looked at by the person
 * then. In `invoice-pdf` and `release-notes` the agent kept going (five messages from one session): the Checklist's
 * moment is leaving such a thread (approval "inbox-one-time-dialogs"). Prints `{ "<thread name>": "<thread id>" }`.
 * Nothing else is written: the release Inbox reads first use from this log.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { InboxStore } from '../../packages/shared/inbox/store';

const [dataDir, src, daysAgo] = process.argv.slice(2);
if (!dataDir || !src || !daysAgo) throw new Error('usage: inbox-board-reveal-seed.ts <data dir> <projects dir> <days ago>');
let at = Date.now() - Number(daysAgo) * 24 * 60 * 60 * 1000;
const store = InboxStore.open(dataDir, { now: () => new Date((at += 60 * 60_000)) });
const ask = (q: string) => [q, '', ':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
/** The threads where one agent sent five messages (a long run). */
const LONG_RUNS = new Set(['invoice-pdf', 'release-notes']);
const THREADS: [project: string, host: string, name: string, subject: string, question: boolean][] = [
  ['billing-svc', 'codex', 'refund-window', 'Which refund window applies to annual plans?', true],
  ['pando', 'claude-code', 'release-notes', 'Review the 0.9 release notes', true],
  ['docs-site', 'pi', 'old-flags', 'Removed the old feature flags', false],
  ['pando', 'claude-code', 'cache-rate', 'Cache hit rate dropped after the deploy', false],
  ['docs-site', 'opencode', 'search-index', 'Rebuilt the search index', false],
  ['billing-svc', 'claude-code', 'invoice-pdf', 'Invoice PDFs render the tax line twice', true],
];
const ids: Record<string, string> = {};
for (const [projectName, host, name, subject, question] of THREADS) {
  const root = join(src, projectName);
  mkdirSync(root, { recursive: true });
  const project = store.ensureProject({ name: projectName, root });
  const author = { kind: 'agent' as const, host, session: `ses_${host.replace(/-/g, '')}_${name.replace(/-/g, '')}`, name: null };
  // The run's updates first, the question last: the thread still waits on the person.
  if (LONG_RUNS.has(name)) {
    for (let step = 1; step <= 4; step++) store.sendMessage({ project_id: project.id, author, thread: name, subject, body: `Step ${step} of the run is done.` });
  }
  const sent = store.sendMessage({
    project_id: project.id,
    author,
    thread: name,
    subject,
    body: question ? ask(subject) : `${subject}. Nothing needed from you.`,
  });
  ids[name] = sent.message.thread_id;
  store.markSeen(sent.message.thread_id);
}
console.log(JSON.stringify(ids));
