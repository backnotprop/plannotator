import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

export interface SearchWorld {
  agents: SimAgent[];
  projects: Record<'plannotator' | 'workspaces' | 'apiWork' | 'apiPersonal' | 'arabic' | 'japanese' | 'northwind', string>;
  threads: Record<'relay' | 'retry' | 'ranking' | 'pagination' | 'cliPagination' | 'arabic' | 'japanese' | 'northwind' | 'release' | 'drafts' | 'schema', string>;
  retryBudget: string;
}

const ask = (prompt: string, choices: string[], extra: string[] = []) => ['', ':::question', prompt, '', ...extra, ...(extra.length ? [''] : []), ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

function file(project: string, path: string, text: string): string {
  const full = join(project, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  return full;
}

async function personReply(url: string, messageId: string, words: string): Promise<string> {
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  const response = await fetch(new URL(`/api/inbox/messages/${messageId}/reply`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotency_key: `k-${messageId}-${words.length}`, words, serverSession: health.serverSession }),
  });
  if (!response.ok) throw new Error(`reply: ${response.status} ${await response.text()}`);
  return ((await response.json()) as { reply: { id: string } }).reply.id;
}

async function windowPost(url: string, path: string, body: Record<string, unknown> = {}): Promise<void> {
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  const response = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
}

export async function seedSearchWorld(input: { binary: string; env: Record<string, string>; root: string; url: string }): Promise<SearchWorld> {
  const src = join(input.root, 'src');
  const projects = {
    plannotator: scratchProject(src, 'plannotator'),
    workspaces: scratchProject(src, 'workspaces'),
    apiWork: scratchProject(join(input.root, 'work'), 'api'),
    apiPersonal: scratchProject(join(input.root, 'personal'), 'api'),
    arabic: scratchProject(src, 'بوابة-الدفع'),
    japanese: scratchProject(src, '決済サービス'),
    northwind: scratchProject(src, 'northwind-industries-holdings-customer-portal-frontend'),
  };
  const claude = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'Claude Code', host: 'claude-code' });
  const pi = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'Pi', host: 'pi' });
  const opencode = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'OpenCode', host: 'opencode' });
  const pause = () => new Promise((r) => setTimeout(r, 15));
  const id = (sent: Record<string, unknown>) => sent.thread_id as string;
  const msg = (sent: Record<string, unknown>) => sent.message_id as string;

  const release = await claude.send({ project_path: projects.plannotator, subject: '🚀 Release 0.28.18 checklist — deploy order 🧪', thread: 'release', body: 'Deploy order: relay first 🛰️, then guides.show, then the release tag. 👩🏽‍💻 Check the relay health before tagging.' });
  await pause();
  const drafts = await claude.send({ project_path: projects.plannotator, subject: 'Migration of annotate drafts to path keys', thread: 'drafts', body: 'The migration keeps the content key and adds the path key. No draft is moved; old drafts still load by their content hash.' });
  await pause();
  const pagination = await opencode.send({ project_path: projects.apiWork, subject: 'Pagination for /v1/orders', thread: 'orders', body: `Offset pagination breaks when orders arrive while a client pages. Proposal: cursor pagination with opaque cursors.${ask('What is the largest page size?', ['50', '100', '500'])}` });
  await pause();
  await personReply(input.url, msg(pagination), 'Cursor pagination, opaque cursors, 100 at most.');
  await pause();
  const cliPagination = await claude.send({ project_path: projects.apiPersonal, subject: 'Pagination bug in the CLI list command', thread: 'cli', body: 'The CLI asks for page 2 with the offset of page 1, so the second page repeats the first 20 rows. Fixed by passing the cursor the server returns.' });
  await pause();
  const schema = await pi.send({ project_path: projects.workspaces, subject: 'Schema migration for the comments table', thread: 'db', body: 'The migration adds resolved_at and an index on (document_id, created_at). It runs in 4 s on a copy of production.' });
  await pause();
  const retry = await claude.send({
    project_path: projects.plannotator,
    subject: 'Retry storm on the relay after a deploy',
    thread: 'retry',
    body: 'After the 14:00 deploy every phone reconnected at once. The backoff starts at 1 s for all of them, so the relay saw a retry storm: 2,000 sockets in the same second.',
    attachments: [file(projects.plannotator, 'apps/relay/docs/retry-policy.md', '# Retry policy\n\nJitter, then doubling up to 60 s.\n')],
  });
  await pause();
  await personReply(input.url, msg(retry), 'Add jitter. Spread the first retry over 5 seconds.');
  const budget = await claude.send({ project_path: projects.plannotator, reply_to: msg(retry), body: 'Done: the first retry now waits 1 to 6 s at random, then doubles up to 60 s. I also set a retry budget of 10 reconnects per minute per phone, under the rate limit on the relay side.' });
  await personReply(input.url, msg(budget), 'Good. Keep the retry budget, and write it in the relay README.');
  await claude.send({ project_path: projects.plannotator, reply_to: msg(budget), body: 'README updated with the retry budget and the jitter. Closing this.' });
  await pause();
  const northwind = await claude.send({
    project_path: projects.northwind,
    subject: 'Investigate why the nightly deploy of the customer-portal-frontend fails only on the second retry when the CDN cache is warm and the feature flag is off',
    thread: 'nightly-deploy-investigation-for-the-customer-portal',
    body: `The nightly deploy fails on the second retry only: https://ci.example.com/pipelines/northwind/customer-portal-frontend/jobs/8812734/artifacts/raw/deploy.log?attempt=2&cache=warm&flag=off shows the CDN serving the old manifest.${ask('Pin the CDN cache key to the build id?', ['Yes', 'No'], ['Holds up: the nightly deploy; the release.'])}`,
    attachments: [
      file(projects.northwind, 'docs/spikes/SPIKE-claude-deploy-pipeline-investigation-for-northwind-customer-portal-20261012.md', '# Spike\n'),
      file(projects.northwind, 'docs/spikes/SPIKE-claude-deploy-pipeline-investigation-for-northwind-customer-portal-20261011.md', '# Spike\n'),
    ],
  });
  {
    const question = (northwind.questions as { key: string; kind: string; prompt: string }[])[0]!;
    const answer = { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ['Yes'] };
    await windowPost(input.url, `/api/inbox/messages/${msg(northwind)}/picks`, { questions: [{ key: question.key, revision: 0, answer }] });
    await windowPost(input.url, `/api/inbox/messages/${msg(northwind)}/reply`, { idempotency_key: 'k-northwind-pin', questions: [{ key: question.key, revision: 1 }] });
  }
  await pi.send({ project_path: projects.workspaces, subject: 'Flaky end-to-end test on the billing page since the Stripe SDK upgrade', body: 'The billing page test fails one run in five since the SDK upgrade; it passes again after each deploy. The checkout iframe loads late.' });
  await pause();
  const japanese = await opencode.send({ project_path: projects.japanese, subject: 'デプロイ後の決済エラーの調査（deploy 2026-10-12）', thread: 'deploy', body: '昨夜の deploy の後、決済APIのタイムアウトが3倍に増えました。原因は接続プールの上限です。修正版を用意しました。' });
  await pause();
  const ranking = await pi.send({ project_path: projects.workspaces, subject: 'Search ranking: current-workspace boost', thread: 'search', body: `Should hits from the workspace you are in rank above others, or only win ties?${ask('How strong is the current-workspace boost?', ['Wins ties only', 'One tier', 'A filter'])}` });
  await personReply(input.url, msg(ranking), 'Keep the boost small, never a filter. Ties only.');
  await pause();
  const arabic = await claude.send({
    project_path: projects.arabic,
    subject: 'تقرير أخطاء الدفع بعد آخر deploy على الخادم الثاني',
    thread: 'المدفوعات',
    body: `فشل الـ deploy على الخادم الثاني بسبب مهلة الاتصال بقاعدة البيانات. أعدت المحاولة مرتين ونجحت الثالثة.${ask('هل نضيف فحص الجاهزية قبل كل deploy؟', ['نعم', 'لا', 'في الإنتاج فقط'])}`,
    attachments: [file(projects.arabic, 'logs/سجل-النشر-٢٠٢٦-١٠-١٣.log', 'deploy log\n')],
  });
  await pause();
  const relay = await claude.send({
    project_path: projects.plannotator,
    subject: 'Relay: rate limit on mailbox creation',
    thread: 'relay',
    body: `The relay brakes only one thing: creating a mailbox. Cloudflare's ratelimits binding allows 20 creates a minute per IP. Pushes are not limited.${ask('Keep the rate limit at 20 mailbox creates a minute per IP?', ['Keep 20 a minute', 'Raise to 60 a minute', 'No limit'], ['Stopped: the relay deploy waits on this.'])}`,
    attachments: [file(projects.plannotator, 'adr/implementation/relay-rate-limits.md', '# Relay rate limits\n')],
  });

  await windowPost(input.url, `/api/inbox/messages/${id(release)}/resolve`, { resolved: true });
  await windowPost(input.url, `/api/inbox/messages/${id(drafts)}/resolve`, { resolved: true });
  await windowPost(input.url, `/api/inbox/messages/${id(pagination)}/resolve`, { resolved: true });
  for (const t of [id(schema), id(retry), id(relay)]) await windowPost(input.url, `/api/inbox/threads/${t}/seen`);

  return {
    agents: [claude, pi, opencode],
    projects,
    threads: {
      relay: id(relay),
      retry: id(retry),
      ranking: id(ranking),
      pagination: id(pagination),
      cliPagination: id(cliPagination),
      arabic: id(arabic),
      japanese: id(japanese),
      northwind: id(northwind),
      release: id(release),
      drafts: id(drafts),
      schema: id(schema),
    },
    retryBudget: msg(budget),
  };
}
