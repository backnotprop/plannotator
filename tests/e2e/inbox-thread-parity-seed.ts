/**
 * The seeded data dir of the thread parity harness (scripts/inbox-thread-parity.ts):
 * one Inbox, filled once through its real routes (agents through `plannotator
 * inbox mcp`, the person through the window's own POSTs), then stopped. Each
 * capture run copies `data/` and starts its own Inbox on the copy, so the
 * reference binary and the branch binary read the same ids, timestamps,
 * looks and picks.
 *
 * The threads cover what the message parts draw (the seed text comes from the
 * specs that prove each part): a seven-message folding thread with answered
 * questions, an annotated file, a guided review and one new message; open,
 * picked and text questions with a reply draft; a replaced question and a
 * Re-ask; image, SVG, markdown, HTML and video files; action items; a settled
 * 👍; a reply that tags a second agent; worst-case text (right to left,
 * long tokens, a table, emoji); and a link choice answered (its raw markdown
 * in the folded line and "You answered", as today) beside picture choices.
 *
 * Live connection state (busy, Undelivered, Send now, restart) lives in the
 * Inbox's memory, never in the data dir, so a copy cannot carry it: the
 * capture polls as the seeded sessions itself (`sessions` in seed.json).
 *
 * Writes `<root>/seed.json`: the thread ids by name and `frozenAt`, the
 * instant every capture's page clock is fixed to.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { refuseRealDataDir } from '../helpers/real-data-dir';
import { markTourDecided } from '../helpers/tour-decided';
import { mp4 } from '../helpers/video-fixtures';

const repo = resolve(__dirname, '../..');

export interface ParitySeed {
  /** The scratch root: `data/` (the seeded data dir) and `src/` (the projects, read by absolute path). */
  root: string;
  dataDir: string;
  /** The page clock of every capture (ISO): two minutes after the last write. */
  frozenAt: string;
  /** Thread ids by name, in capture order. */
  threads: Record<string, string>;
  /** The agent session that asked in a thread, by thread name (the live captures poll as it). */
  sessions: Record<string, string>;
  /** The binary that wrote the seed. */
  seededBy: string;
}

/** The environment of every process the harness starts: sandboxed, no browser, no network, no agents. */
export function parityEnv(home: string, dataDir: string): Record<string, string> {
  refuseRealDataDir(dataDir, 'parityEnv');
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    // No offer to add a note to an agent's instructions (the scratch HOME has a ~/.claude for the restart line).
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
    PLANNOTATOR_INSTALL_SCRIPT_URL: 'http://127.0.0.1:9/install.sh',
  };
}

const q = (prompt: string, choices: string[], extra: string[] = []) => [':::question', prompt, ...extra, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');
const text = (prompt: string) => [':::question-text', prompt, ':::'].join('\n');

// The folding thread (inbox-thread-folding.spec.ts).
const ASK = [
  'I looked at three ways to add search to the docs site. Short version: the site is static, about 240 pages, and every option works with the Astro build we already have.',
  '',
  '| Option | How it runs | Cost |',
  '| --- | --- | --- |',
  '| Pagefind | Index built at deploy, searched in the browser | ~1.6 MB index, no service |',
  '| Algolia DocSearch | Hosted crawler and API | Free for open source, needs approval |',
  '',
  'Two calls before I start:',
  '',
  ':::question',
  'Which search index should the docs site use for its first public release, given the **1.6 MB** index, the `astro build` step in CI and the review deadline this Friday?',
  '',
  '- [ ] Pagefind',
  '- [ ] Algolia DocSearch',
  '',
  'Recommended: Pagefind',
  ':::',
  '',
  ':::question-multi',
  'Which sections go in the index?',
  '',
  '- [ ] Guides',
  '- [ ] API reference',
  '- [ ] Blog',
  ':::',
].join('\n');
const PLAN = ['Pagefind is wired into the build on a branch. Before I polish it, here is the plan. Annotate it if something is off.', '', q('Which shortcut opens search?', ['/ and ⌘K', '⌘K only'])].join('\n');
const LATEST = [
  'CI is green. The empty state now offers the closest section and a GitHub search link.',
  '',
  'One number changed my mind about deploys: the index is **1.8 MB** across 312 files, and building it on every deploy adds about **40 seconds** to each preview build.',
  '',
  '- The index is uploaded with the site, never served from elsewhere.',
  '- The panel keeps the last query when it reopens.',
  '',
  q('When should the search index build?', ['On main and release tags', 'On every deploy'], ['', 'Stopped: the docs-search branch cannot merge without this.']),
].join('\n');

// Replaced and Re-ask (inbox-replaced.spec.ts, inbox-reask.spec.ts).
const WORKER = [
  'I checked the 409 row against the Stripe docs. Two things before I go on.',
  '',
  q('Which way should the worker go on a Stripe 409?', ['Retry with the same idempotency key', 'Fail the job and send it to the dead-letter queue'], ['Stopped: the retry worker cannot ship without this.']),
  '',
  q('Ship the retry behind a flag?', ['Yes', 'No'], ['', 'The flag would be `billing.retry_409`, off by default.']),
].join('\n');
const QUEUE = [
  'You moved the 409 handling into the jobs queue in our session, so my worker question no longer fits. This is the one the queue needs.',
  '',
  q('How many times should the jobs queue retry a Stripe 409 before it dead-letters the job?', ['3 times over 10 minutes', 'Once, then dead-letter', 'Never retry; dead-letter at once'], ['', 'Stopped: the queue change cannot merge without this.']),
].join('\n');

// Action items (inbox-actions.spec.ts).
const ACTIONS = [
  'These are secrets, so only you can do them.',
  '',
  ':::action',
  'Set the GitHub App client secret on staging',
  'On the App\'s page, click "Generate a new client secret" and copy it.',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  'Run: `pbpaste | npx wrangler secret put APPNOTES_GITHUB_APP_CLIENT_SECRET --env staging`',
  'Holds up: staging sign-in with GitHub',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  ':::action',
  'Approve the staging deploy on Vercel',
  'Where: [Vercel](https://vercel.com/acme/appnotes/deployments)',
  'Stopped: release 4.2 cannot go out until it is approved',
  ':::',
  '',
  q('Publish 0.29 as latest, or as next first?', ['latest', 'next first'], ['', 'Recommended: next first']),
].join('\n');

// Worst-case text (inbox-mobile.spec.ts, inbox-worst-case.spec.ts). Made-up strings, nothing like a real key.
const LONG_URL = 'https://hooks.example.com/stripe/v1/refunds/reconcile/billing-svc/production/us-east-1/account-0001-placeholder-0002-placeholder-0003?sig=9f8e7d6c5b4a3928170615243342516071829304a5b6c7d8e9f0&replay=true';
const WORST = [
  `The webhook endpoint is ${LONG_URL}`,
  '',
  `Rotate the key \`example_key_${'a1B2c3D4e5F6g7H8'.repeat(5)}\` before Friday. Raw token: example_token_${'0123456789abcdef'.repeat(6)}`,
  '',
  'שלום! הסנכרון הלילי של ספר החשבונות נכשל פעמיים הלילה. مرحبا، فشلت المزامنة الليلية مرتين. 🚀🔥✅ 👩🏽‍💻',
  '',
  '| Region | Failed payouts | Oldest |',
  '| --- | ---: | --- |',
  '| us-east-1 | 1,204 | 3 days |',
  '| eu-central-1 | 17 | 2 hours |',
  '',
  '```ts',
  "export const RETRY_POLICY = { attempts: 5, backoff: 'exponential', maxDelayMs: 3_600_000, deadLetter: 'refunds-dlq-production-us-east-1' } as const;",
  '```',
  '',
  q('Which idempotency key format should the retry worker use?', [`idem_01HZX9QW3E5R7T9Y1U3I5O7P9A1S3D5F7G9H1J3K5L7Z9X1C3V5B7N9M1Q3W5E7R9T1Y3U5I7O9P1A3S5D7F9G1H3J5K7L9`, 'charge id plus attempt number'], ['Stopped: the retry worker cannot ship without this.']),
].join('\n');

// Link choices (answered: today's folded line and "You answered" keep the raw markdown) and picture choices
// (inbox-picture-choices.spec.ts).
const LINKS = ['Two libraries fit. Pick one and I will wire it in.', '', q('Which search library should the docs use?', ['[Pagefind](https://pagefind.app)', '[Algolia DocSearch](https://docsearch.algolia.com)'])].join('\n');
const DRAWERS = [
  'Two drawer designs for checkout.',
  '',
  ':::question',
  'Which checkout drawer should ship?',
  'Stakes: ships to all of checkout on Thursday; changing it later costs a week of QA.',
  'Shows: ![Both drawers side by side](shots/both.png)',
  'Reversible: no — the old drawer code is deleted with the release',
  '',
  '- [ ] A · Total on top — ![Drawer A](shots/drawer-a.png) closest to today',
  '- [ ] B · Total pinned with Pay — ![Drawer B](shots/drawer-b.png) the total never scrolls away',
  '',
  'Recommended: B · Total pinned with Pay',
  '',
  'Why: on a 320 px screen only B keeps the total next to the button.',
  ':::',
].join('\n');

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[]; attachments?: { id: string }[] };
const answer = (question: Sent['questions'][number], selected: string[]) => ({ key: question.key, revision: 0, answer: { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected } });

async function until(what: string, check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`seed: timed out waiting for ${what}`);
}

/** Fill a new Inbox under `root/data` with `binary`; stop it; return the manifest (also written to root/seed.json). */
export async function seedThreadParity(binary: string, root: string, stop: (dataDir: string) => Promise<void>): Promise<ParitySeed> {
  const dataDir = join(root, 'data');
  const home = join(root, 'seed-home');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  const env = parityEnv(home, dataDir);
  const started = spawnSync(binary, ['inbox', '--background'], { env, cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (started.status !== 0) throw new Error(`seed: inbox --background failed: ${started.stderr}`);
  const url = started.stdout.trim().replace(/\/$/, '');
  const post = async (path: string, body: unknown): Promise<Record<string, any>> => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`seed: POST ${path} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as Record<string, any>;
  };
  const get = async (path: string): Promise<Record<string, any>> => (await (await fetch(`${url}${path}`)).json()) as Record<string, any>;
  // The one-time notification line is not what these captures are about.
  await post('/api/inbox/settings', { notifications: { dismissed: true } });

  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  writeFileSync(join(docs, 'search-plan.md'), '# Search plan\n\nThe index builds after `astro build`, in CI only.\n\nResults are grouped by section.\n');
  mkdirSync(join(billing, 'docs'), { recursive: true });
  mkdirSync(join(billing, 'shots'), { recursive: true });
  writeFileSync(join(billing, 'docs', 'retry-policy.md'), '# Retry policy\n\nFailed refunds are retried with exponential backoff, five times at most.\n\n| Attempt | Delay |\n| --- | --- |\n| 1 | 1 min |\n| 2 | 5 min |\n');
  writeFileSync(join(billing, 'docs', 'retry-dashboard.html'), '<!doctype html><html><head><title>Retry dashboard</title></head><body style="font:16px system-ui;margin:24px"><h1>Retry dashboard</h1><p>1,204 failed payouts in us-east-1.</p></body></html>\n');
  writeFileSync(join(billing, 'docs', 'refund-states.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120"><rect width="240" height="120" fill="#f4f1ea"/><rect x="16" y="40" width="80" height="40" rx="6" fill="#3b82f6"/><rect x="144" y="40" width="80" height="40" rx="6" fill="#16a34a"/><path d="M96 60h48" stroke="#111" stroke-width="3"/></svg>\n');
  for (const name of ['retry-policy-desktop.png', 'both.png', 'drawer-a.png', 'drawer-b.png']) copyFileSync(join(repo, 'packages/review-editor/assets/pr-artifact-icons/image.png'), join(billing, 'shots', name));
  writeFileSync(join(billing, 'shots', 'retry-walkthrough.mp4'), mp4());

  const agents: SimAgent[] = [];
  const agent = async (name: string, host: string) => {
    const made = await SimAgent.connect({ binary, env, name, host });
    agents.push(made);
    return made;
  };
  const threads: Record<string, string> = {};
  const sessions: Record<string, string> = {};
  const sessionOf = async (threadId: string) => ((await get(`/api/inbox/threads/${threadId}`)).thread.messages[0].author.session as string) ?? '';
  try {
    // 1. Folding: seven messages, questions answered, an annotated file, a guided review, one new.
    const claude = await agent('Claude Code', 'claude-code');
    const ask = (await claude.send({ project_path: docs, subject: 'Search for the docs site', body: ASK })) as Sent;
    threads.folding = ask.thread_id;
    const [index, sections] = ask.questions;
    await post(`/api/inbox/messages/${ask.message_id}/reply`, { idempotency_key: 'r1', questions: [answer(index!, ['Pagefind']), answer(sections!, ['Guides', 'API reference'])] });
    const plan = (await claude.send({ project_path: docs, body: PLAN, reply_to: ask.message_id, attachments: ['search-plan.md'] })) as Sent;
    for (const id of ['ann-1', 'ann-2']) {
      await post('/api/inbox/annotations', {
        attachment_id: plan.attachments![0]!.id,
        version: 'current',
        annotation: { id, type: 'COMMENT', text: 'Show the section path on each result.', originalText: 'Results are grouped by section.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 },
      });
    }
    await post(`/api/inbox/messages/${plan.message_id}/reply`, {
      idempotency_key: 'r2',
      words: 'The plan is close. Two notes on the file.',
      questions: [answer(plan.questions[0]!, ['/ and ⌘K'])],
      feedback: '# Feedback on the attached files\n\nShow the section path on each result.',
      annotation_ids: ['ann-1', 'ann-2'],
    });
    const { example } = await claude.guideBrief();
    const guide = (await claude.submitGuide({ project_path: docs, ...example, body: 'Both notes are in: results show the section path. Ready for a read, file by file.', reply_to: ask.message_id })) as Sent;
    await post(`/api/inbox/messages/${guide.message_id}/reply`, { idempotency_key: 'r3', words: 'Read it, looks good. One thing: an empty result says only "No results".' });
    await claude.readThread(ask.thread_id);
    await post(`/api/inbox/threads/${ask.thread_id}/seen`, {});
    await claude.send({ project_path: docs, body: LATEST, reply_to: ask.message_id });

    // 2. Questions: open (choice, multi, text), one picked into the draft, and a reply draft with words.
    const asker = await agent('Claude Code', 'claude-code');
    const first = (await asker.send({ project_path: billing, subject: 'Retry worker for failed Stripe charges', body: `I'm adding a retry worker.\n\n${q('Which queue backs the retry worker?', ['Postgres (pg-boss)', 'Redis'])}` })) as Sent;
    threads.questions = first.thread_id;
    await asker.send({ project_path: billing, reply_to: first.message_id, body: `Rate limits next.\n\n${q('How many times should a rate-limited charge be retried?', ['3', '5', '10'], ['Holds up: the retry worker; the admin page'])}` });
    const flag = (await asker.send({ project_path: billing, reply_to: first.message_id, body: `The worker runs end to end in staging.\n\n${q('Ship the retry worker behind a flag?', ['Yes', 'No'])}\n\n${text('Anything the on-call runbook should say about the retry worker?')}` })) as Sent;
    await post(`/api/inbox/messages/${flag.message_id}/picks`, { questions: [answer(flag.questions[0]!, ['Yes'])] });
    await post(`/api/inbox/threads/${first.thread_id}/draft`, { body: 'Postgres is fine for now; we already run pg-boss for the mailer.', base: null });

    // 3. Replaced and Re-ask: question 1 replaced by the queue question; Re-ask on what stays open.
    const replacer = await agent('Claude Code', 'claude-code');
    const worker = (await replacer.send({ project_path: billing, subject: 'Which way on a Stripe 409?', body: WORKER })) as Sent;
    threads.replaced = worker.thread_id;
    await replacer.send({ project_path: billing, body: QUEUE, reply_to: worker.message_id, supersedes: [`${worker.message_id}/${worker.questions[0]!.key}`] });
    await post(`/api/inbox/messages/${worker.message_id}/reask`, { idempotency_key: 'parity-reask' });

    // 4. Files: an image, an SVG, markdown, HTML and a video, plus the image in the text.
    const filer = await agent('OpenCode', 'opencode');
    const files = (await filer.send({
      project_path: billing,
      subject: 'The retry policy, written down',
      body: 'The policy and the dashboard are attached. Today\'s page, for reference:\n\n![Today\'s retry page](shots/retry-policy-desktop.png)\n\nThe walkthrough is the short video.',
      attachments: ['docs/retry-policy.md', 'docs/retry-dashboard.html', 'docs/refund-states.svg', 'shots/retry-policy-desktop.png', 'shots/retry-walkthrough.mp4'],
    })) as Sent;
    threads.files = files.thread_id;

    // 5. Action items and a question beside them.
    const actor = await agent('Claude Code', 'claude-code');
    threads.actions = ((await actor.send({ project_path: billing, subject: 'Staging secrets and the deploy', body: ACTIONS })) as Sent).thread_id;

    // 6. 👍 Looks good, settled (sent to the agent once its Undo window passed) and delivered (below).
    const pi = await agent('Pi', 'pi');
    const merged = (await pi.send({ project_path: docs, subject: 'Toast fix merged; CI is green', body: "Merged #1937. CI is green on `main` and the release branch picked it up.\n\nNothing needs you here. Next I'm looking at the stepping bug in full screen." })) as Sent;
    threads.ack = merged.thread_id;
    await post(`/api/inbox/messages/${merged.message_id}/ack`, { ack: true });

    // 7. Delivery and tags: a reply the agent read (Delivered), one it has not (Sent) that tags another agent.
    const talker = await agent('Claude Code', 'claude-code');
    const talk = (await talker.send({ project_path: billing, subject: 'Nightly reconciliation', body: 'Starting the nightly reconciliation work. I will post progress here.' })) as Sent;
    threads.delivery = talk.thread_id;
    await post(`/api/inbox/messages/${talk.message_id}/reply`, { idempotency_key: 'd1', words: 'Keep going, and tell me when batch 1 matches.' });
    await talker.readThread(talk.thread_id);
    const batch = (await talker.send({ project_path: billing, reply_to: talk.message_id, body: 'Batch 1 done: 120 payouts checked, 1 mismatch, all timing.' })) as Sent;
    const piSession = ((await get(`/api/inbox/threads/${merged.thread_id}`)).thread.messages[0].author.session as string) ?? '';
    await post(`/api/inbox/messages/${batch.message_id}/reply`, { idempotency_key: 'd2', words: 'Thanks. Pi, can you look at the one mismatch?', tags: [{ host: 'pi', session: piSession, label: 'Pi' }] });

    // 8. Worst case: right to left, long tokens, a table, code, emoji, a long choice.
    const worst = await agent('Codex', 'codex');
    threads.worst = ((await worst.send({ project_path: billing, subject: 'Webhook URL, key rotation and the nightly sync (נכשל / فشلت)', body: WORST })) as Sent).thread_id;

    // 9. Choices: a link choice answered, then picture choices open.
    const chooser = await agent('Claude Code', 'claude-code');
    const links = (await chooser.send({ project_path: billing, subject: 'Search library and the checkout drawer', body: LINKS })) as Sent;
    threads.choices = links.thread_id;
    const linkQuestion = ((await get(`/api/inbox/threads/${links.thread_id}`)).thread.messages[0].questions as { key: string; choices: { label: string }[] }[])[0]!;
    await post(`/api/inbox/messages/${links.message_id}/reply`, { idempotency_key: 'c1', questions: [answer(links.questions[0]!, [linkQuestion.choices[0]!.label])] });
    await chooser.readThread(links.thread_id);
    await chooser.send({ project_path: billing, body: DRAWERS, reply_to: links.message_id });

    for (const name of ['delivery', 'replaced', 'ack']) sessions[name] = await sessionOf(threads[name]!);

    // The 👍 settles once its Undo window has passed (the Inbox's sweep); wait so no copy settles it later.
    await until('the 👍 to settle', async () => {
      const t = (await get(`/api/inbox/threads/${merged.thread_id}`)).thread as { messages: { id: string; ack?: { settled_at: string | null } | null }[] };
      return Boolean(t.messages.find((m) => m.id === merged.message_id)?.ack?.settled_at);
    });
    // Pi picks it up: the pill reads "Delivered to Pi" and the row's tick is Delivered.
    await pi.waitForReply(merged.thread_id, 20);
  } finally {
    await Promise.all(agents.map((a) => a.close().catch(() => {})));
    await stop(dataDir);
  }

  const frozenAt = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000).toISOString();
  const seed: ParitySeed = { root, dataDir, frozenAt, threads, sessions, seededBy: binary };
  writeFileSync(join(root, 'seed.json'), JSON.stringify(seed, null, 2));
  return seed;
}

export function readParitySeed(root: string): ParitySeed {
  return JSON.parse(readFileSync(join(root, 'seed.json'), 'utf8')) as ParitySeed;
}
