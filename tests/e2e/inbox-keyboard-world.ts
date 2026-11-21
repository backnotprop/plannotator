/**
 * The scratch Inbox the keyboard journeys run in (inbox-keyboard-journeys.spec.ts):
 * the compiled binary under a temp HOME and PLANNOTATOR_DATA_DIR
 * (inbox-scratch.ts, stopped only once proven to be this world's), no browser
 * opened by the Inbox (NO_BROWSER), no agent connections written
 * (PLANNOTATOR_INBOX_CONNECT=0), the tour decided, and agents writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * The threads: Stopped (two questions), Holding (one question and a saved
 * reply draft), Checkout (an older message with an image and a Markdown file;
 * the newest with a question, an image, an HTML page and a video), Rollout (a
 * long thread: eight messages, the first six read and folded, message 3 with
 * a plan and a page, message 8 with an image and a question), Refund (read:
 * in Quiet), and News. The Board is on with three cards, its first-visit
 * dialog seen; Decide mode is on. JOURNEYS.md (approval
 * "inbox-keyboard-shortcuts") is what the journeys spec walks through.
 */
import { copyFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
export const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

export interface KeyboardWorld {
  root: string;
  dataDir: string;
  url: string;
  agents: SimAgent[];
  threads: { stopped: string; holding: string; checkout: string; rollout: string; refund: string; news: string };
  files: { olderImage: string; spec: string; image: string; page: string; video: string; plan: string; planPage: string; dashboard: string };
  /** Holding's saved reply draft. */
  holdingDraft: string;
}

const STOPPED = [
  'I checked the 409 row against the Stripe docs. Two things before I go on.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  'Stopped: the retry worker cannot ship without this.',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job',
  ':::',
  '',
  ':::question',
  'Should a retried job page on-call?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const HOLDING = ['The installer can detect agents two ways.', '', ':::question', 'Detect the installed agents, or ask?', '', '- [ ] Detect them', '- [ ] Ask each time', ':::'].join('\n');

const CHECKOUT_NEW = [
  'The drawer is built. The page and the screenshot are attached, plus a short film of it opening.',
  '',
  ':::question',
  'Ship the drawer to everyone, or behind the flag first?',
  '',
  '- [ ] Everyone',
  '- [ ] Behind the flag (recommended)',
  ':::',
].join('\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Checkout drawer</title>
<style>body{font:15px system-ui;margin:0}header{background:#4f46e5;color:#fff;padding:14px 20px}main{padding:20px}label{display:block;margin:10px 0 4px}input{width:320px;padding:6px}</style>
</head><body><header>Checkout · drawer</header><main><h2>Shipping</h2><label>Name</label><input value="Dana Whitfield"><label>Street</label><input value="418 Larch St"></main></body></html>`;

/** A paragraph long enough that eight of them make the thread scroll about three screens. */
const para = (n: number, topic: string) =>
  `Step ${n} of the rollout: ${topic}. ` +
  'We watch the error rate and the p95 latency for a full hour before the next step, and roll back by flipping the flag if either moves more than ten percent. '.repeat(3);

const ROLLOUT_TOPICS = ['the plan', 'staging soak', 'the plan and the page', 'canary at one percent', 'ten percent', 'half the traffic', 'everyone but EU', 'everyone'];

const ROLLOUT_LAST = [
  para(8, ROLLOUT_TOPICS[7]!),
  '',
  // Long enough that the newest message alone is taller than the window: the thread always scrolls.
  ...Array.from({ length: 6 }, (_, i) => ['', `Check ${i + 1}: ${'the dashboards stay green, the error budget holds, and support sees no rise in checkout tickets. '.repeat(3)}`]).flat(),
  '',
  ':::question',
  'Go to everyone today, or hold EU until Monday?',
  '',
  '- [ ] Everyone today',
  '- [ ] Hold EU until Monday',
  ':::',
].join('\n');

const PLAN = '# Rollout plan\n\n## Steps\n\n1. Staging soak, one day.\n2. Canary at 1%.\n3. 10%, then 50%.\n4. Everyone but EU, then everyone.\n\n## Rollback\n\nFlip `checkout.drawer` off. No deploy needed.\n';

const PLAN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Rollout</title><style>body{font:15px system-ui;margin:0}header{background:#0f766e;color:#fff;padding:14px 20px}main{padding:20px}td{padding:4px 12px}</style></head><body><header>Rollout · status</header><main><table><tr><td>Staging</td><td>done</td></tr><tr><td>Canary</td><td>done</td></tr><tr><td>10%</td><td>today</td></tr></table></main></body></html>`;

const SPEC = '# Checkout drawer\n\nThe drawer slides in from the right, 420 px wide, and keeps the cart behind it.\n\n- Escape closes it.\n- Focus starts on the first field.\n';

async function post(url: string, path: string, body: unknown): Promise<void> {
  const origin = new URL(url).origin;
  const response = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
}

export async function createKeyboardWorld(prefix = 'plannotator-inbox-keyboard-'): Promise<KeyboardWorld> {
  const root = inboxScratch(prefix);
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  // The sibling specs' sandbox switches: no agent configs, no tailnet, phones or notes, no update check, no relay.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  if (started.status !== 0) throw new Error(`the Inbox did not start: ${started.stderr}`);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'billing');
  const content = join(repo, 'packages/inbox/tour/content');
  const files = { olderImage: 'before.webp', spec: 'drawer-spec.md', image: 'after.webp', page: 'checkout-drawer.html', video: 'drawer-open.mp4', plan: 'rollout.md', planPage: 'rollout.html', dashboard: 'dashboard.webp' };
  copyFileSync(join(content, 'vs-a.webp'), join(project, files.olderImage));
  copyFileSync(join(content, 'vs-b.webp'), join(project, files.image));
  copyFileSync(join(content, 'film-clip.mp4'), join(project, files.video));
  writeFileSync(join(project, files.page), PAGE);
  writeFileSync(join(project, files.spec), SPEC);
  copyFileSync(join(content, 'vs-a.webp'), join(project, files.dashboard));
  writeFileSync(join(project, files.plan), PLAN);
  writeFileSync(join(project, files.planPage), PLAN_PAGE);

  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pause = () => new Promise((r) => setTimeout(r, 25));

  // Rollout: six messages read (folded when the thread opens), then two new ones.
  let rolloutLast = await claude.send({ project_path: project, subject: 'Checkout drawer rollout', thread: 'rollout', body: para(1, ROLLOUT_TOPICS[0]!) });
  const rolloutId = rolloutLast.thread_id as string;
  for (let n = 2; n <= 6; n++) {
    await pause();
    rolloutLast = await claude.send({ project_path: project, reply_to: rolloutLast.message_id as string, body: para(n, ROLLOUT_TOPICS[n - 1]!), ...(n === 3 ? { attachments: [files.plan, files.planPage] } : {}) });
  }
  await post(url, `/api/inbox/threads/${encodeURIComponent(rolloutId)}/read`, {});
  await pause();
  rolloutLast = await claude.send({ project_path: project, reply_to: rolloutLast.message_id as string, body: para(7, ROLLOUT_TOPICS[6]!) });
  await pause();
  await claude.send({ project_path: project, reply_to: rolloutLast.message_id as string, body: ROLLOUT_LAST, attachments: [files.dashboard] });
  await pause();
  const news = await codex.send({ project_path: project, subject: 'Nightly build is green', thread: 'news', body: 'The nightly build is green again.' });
  await pause();
  const refund = await claude.send({ project_path: project, subject: 'Refund events: trust the webhook', thread: 'refund', body: 'The refund webhook is the source of truth now; the poller is gone.' });
  await pause();
  const older = await codex.send({ project_path: project, subject: 'Checkout drawer: before and after', thread: 'checkout', body: 'Here is the checkout as it is today, and the spec for the drawer.', attachments: [files.olderImage, files.spec] });
  await pause();
  const checkout = await codex.send({ project_path: project, reply_to: older.message_id as string, body: CHECKOUT_NEW, attachments: [files.image, files.page, files.video] });
  await pause();
  const holding = await codex.send({ project_path: project, subject: 'Installer: detect agents', thread: 'installer', body: HOLDING });
  await pause();
  const stopped = await claude.send({ project_path: project, subject: 'Retry worker: Stripe 409', thread: 'worker', body: STOPPED });

  const holdingDraft = 'Detect them, but ask before writing any config';
  await post(url, `/api/inbox/threads/${encodeURIComponent(holding.thread_id as string)}/draft`, { body: holdingDraft, base: null });
  // Refund is read (Quiet); the Board is on with three cards, its intro seen; Decide mode is on.
  await post(url, `/api/inbox/threads/${encodeURIComponent(refund.thread_id as string)}/read`, {});
  await post(url, '/api/inbox/settings', { board: { on: true } });
  // The Board's first-visit dialog is claimed here, so G B lands on the Board itself (the dialog is inbox-board.spec.ts's).
  await post(url, '/api/inbox/board/intro', {});
  await post(url, '/api/inbox/settings', { experimental: { decision_mode: true } });
  for (const title of ['Retry worker on Stripe 409', 'Checkout drawer', 'Installer detects agents']) await claude.card({ op: 'create', project_path: project, title });

  return {
    root,
    dataDir,
    url,
    agents: [claude, codex],
    threads: {
      stopped: stopped.thread_id as string,
      holding: holding.thread_id as string,
      checkout: checkout.thread_id as string,
      rollout: rolloutId,
      refund: refund.thread_id as string,
      news: news.thread_id as string,
    },
    files,
    holdingDraft,
  };
}
