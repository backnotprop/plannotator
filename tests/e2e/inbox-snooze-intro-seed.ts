import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { InboxStore } from '../../packages/shared/inbox/store';

const [dataDir, src, daysAgo] = process.argv.slice(2);
if (!dataDir || !src || !daysAgo) throw new Error('usage: inbox-snooze-intro-seed.ts <data dir> <projects dir> <days ago>');
let at = Date.now() - Number(daysAgo) * 24 * 60 * 60 * 1000;
const store = InboxStore.open(dataDir, { now: () => new Date((at += 60_000)) });
const ask = (q: string) => [q, '', ':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const THREADS: [project: string, host: string, name: string, subject: string][] = [
  ['billing-svc', 'codex', 'refund-window', 'Which refund window applies to annual plans?'],
  ['pando', 'claude-code', 'release-notes', 'Review the 0.9 release notes'],
  ['docs-site', 'pi', 'old-flags', 'Remove the old feature flags'],
  ['pando', 'claude-code', 'cache-rate', 'Cache hit rate dropped after the deploy'],
];
const ids: Record<string, string> = {};
for (const [projectName, host, name, subject] of THREADS) {
  const root = join(src, projectName);
  mkdirSync(root, { recursive: true });
  const project = store.ensureProject({ name: projectName, root });
  const sent = store.sendMessage({
    project_id: project.id,
    author: { kind: 'agent', host, session: `ses_${host.replace(/-/g, '')}_${name.replace(/-/g, '')}`, name: null },
    thread: name,
    subject,
    body: ask(subject),
  });
  ids[name] = sent.message.thread_id;
  store.markSeen(sent.message.thread_id);
}
console.log(JSON.stringify(ids));
