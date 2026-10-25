/**
 * Design prototype only (apps/inbox/proto-imessage): fill a scratch Inbox with
 * realistic threads for the Messages-style layout. Agents write through the
 * real stdio MCP entry (SimAgent); the person picks, replies and 👍s through
 * the window's own HTTP routes. Never the real data dir.
 *
 *   bun scripts/proto-imessage-seed.ts --binary <plannotator wrapper> --data-dir /tmp/…/data --url http://localhost:<port>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { FIXTURE_V1_LOCAL } from '../packages/core/guide-format-fixtures';
import { DEMO_MESSAGES, SimAgent, scratchProject } from './inbox-sim';
import { refuseRealDataDir } from '../tests/helpers/real-data-dir';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const binary = resolve(flag('--binary') ?? '');
const dataDir = resolve(flag('--data-dir') ?? '');
const url = (flag('--url') ?? '').replace(/\/$/, '');
refuseRealDataDir(dataDir, 'proto-imessage-seed');

const src = join(dirname(dataDir), 'src');
const billing = scratchProject(src, 'billing-svc');
const docs = scratchProject(src, 'docs-site');
const mobile = scratchProject(src, 'mobile-app');

/** Real pictures: small HTML mocks rendered by Chromium. */
async function shoot(file: string, html: string, width: number, height: number): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:-apple-system,Inter,sans-serif">${html}</body></html>`);
  await page.screenshot({ path: file });
  await browser.close();
}

const card = (title: string, body: string, accent: string) => `
  <div style="height:100vh;box-sizing:border-box;padding:22px;background:linear-gradient(160deg,#f6f7fb,#e9ecf5)">
    <div style="font-size:13px;color:#6b7080;letter-spacing:.02em">${title}</div>
    <div style="margin-top:12px;background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(20,30,60,.08)">${body}</div>
    <div style="margin-top:14px;height:8px;width:60%;border-radius:4px;background:${accent}"></div>
  </div>`;

async function pictures(): Promise<void> {
  const bars = [62, 80, 45, 92, 70, 88, 54]
    .map((h, i) => `<div style="flex:1;margin:0 4px;height:${h}%;border-radius:6px 6px 0 0;background:${i === 3 ? '#e5484d' : '#3e63dd'}"></div>`)
    .join('');
  await shoot(join(billing, 'shots/retries.png'), card('Stripe 409s per hour, last 7 days', `<div style="display:flex;align-items:flex-end;height:150px">${bars}</div><div style="margin-top:10px;font-size:12px;color:#6b7080">Thursday spiked to 1,204 conflicts after the deploy</div>`, '#3e63dd'), 420, 300);
  await shoot(join(billing, 'shots/dlq.png'), card('Dead-letter queue', ['inv_8Hq2 · 409 · retried 3×', 'inv_8Hq9 · 409 · retried 3×', 'inv_8Hr1 · 500 · retried 1×'].map((r) => `<div style="padding:9px 0;border-bottom:1px solid #eef0f5;font:13px ui-monospace,monospace">${r}</div>`).join(''), '#e5484d'), 420, 260);
  const phone = (label: string, color: string, rows: string[]) => `
    <div style="height:100vh;background:#111;display:flex;align-items:center;justify-content:center">
      <div style="width:210px;height:420px;border-radius:32px;background:#fff;overflow:hidden;border:6px solid #222">
        <div style="height:120px;background:${color};color:#fff;padding:24px 16px;box-sizing:border-box;font-weight:600;font-size:18px">${label}</div>
        ${rows.map((r) => `<div style="margin:12px 14px;padding:12px;border-radius:12px;background:#f2f3f7;font-size:12px">${r}</div>`).join('')}
      </div>
    </div>`;
  await shoot(join(mobile, 'shots/onboarding-a.png'), phone('Welcome back', '#3e63dd', ['Sign in with Apple', 'Continue with email', 'Skip for now']), 300, 460);
  await shoot(join(mobile, 'shots/onboarding-b.png'), phone('Pick your plan', '#30a46c', ['Starter · free', 'Pro · $8/mo', 'Team · $20/seat']), 300, 460);
  await shoot(join(docs, 'report/links.png'), card('Link check · docs-site', '<div style="font-size:40px;font-weight:700;color:#30a46c">412 / 412</div><div style="font-size:13px;color:#6b7080">links resolve · 0 redirects · 3.1 s</div>', '#30a46c'), 420, 240);
}

function files(): void {
  writeFileSync(join(billing, 'PLAN-retries.md'), '# Retry worker\n\n1. Retry 409s with the same idempotency key\n2. Back off 2^n seconds, at most 5 tries\n3. Dead-letter after the last try\n');
  writeFileSync(join(billing, 'worker.log'), Array.from({ length: 40 }, (_, i) => `2026-10-25T18:${String(i).padStart(2, '0')}:00Z WARN stripe 409 inv_8H${i} retry=${i % 3}`).join('\n'));
  writeFileSync(join(docs, 'report/links.html'), '<!doctype html><title>Link check</title><h1>Link check</h1><p>412 of 412 links resolve.</p>');
  writeFileSync(join(mobile, 'flows.md'), '# Onboarding flows\n\nA: sign in first. B: plan first, sign in at checkout.\n');
}

type Json = Record<string, any>;
let serverSession = '';
async function api(path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${url}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, serverSession }) } : {});
  const json = (await res.json()) as Json;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
async function thread(id: string): Promise<Json> {
  return (await api(`/api/inbox/threads/${id}`)).thread;
}
function answer(q: Json, selected: string[]): Json {
  return { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected };
}
async function pick(messageId: string, q: Json, selected: string[]): Promise<Json> {
  const result = await api(`/api/inbox/messages/${messageId}/picks`, { questions: [{ key: q.key, revision: q.revision, answer: answer(q, selected) }] });
  return (result.questions as Json[]).find((x) => x.key === q.key)!;
}

async function main(): Promise<void> {
  await pictures();
  files();
  serverSession = (await api('/api/inbox/threads')).serverSession;
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? dataDir, PLANNOTATOR_DATA_DIR: dataDir, NO_BROWSER: '/usr/bin/true', PLANNOTATOR_BROWSER: '/usr/bin/true', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const agent = (name: string, host: string) => SimAgent.connect({ binary, env, name, host });
  const claude = await agent('Claude Code', 'claude-code');
  const claude2 = await agent('Claude Code', 'claude-code');
  const opencode = await agent('OpenCode', 'opencode');
  const pi = await agent('Pi', 'pi');
  const codex = await agent('Codex', 'codex');
  const codex2 = await agent('Codex', 'codex');
  const out: Json = {};
  try {
    // 1. Quiet: an old thread the person 👍'd.
    const q1 = await codex.send({ project_path: docs, subject: 'Typo sweep merged', body: 'Fixed 31 typos across the guides and merged it as #812. Nothing for you to do.' });
    // 2. Sent: the person answered, the agent has not read it.
    const s1 = await claude2.send({ project_path: billing, thread: 'refund-webhooks', body: DEMO_MESSAGES.named });
    // 3. A thread with a real conversation: question, answer, the agent read it, followed up, 👍.
    const c1 = await pi.send({
      project_path: mobile,
      subject: 'Onboarding: which flow ships?',
      body: [
        'I built both onboarding flows behind a flag. Here they are side by side:',
        '',
        '![Flow A](shots/onboarding-a.png)',
        '![Flow B](shots/onboarding-b.png)',
        '',
        ':::question-multi',
        'Which platforms get the new flow first?',
        '- [ ] iOS',
        '- [ ] Android',
        '- [ ] Web',
        'Recommended: iOS',
        ':::',
      ].join('\n'),
      attachments: ['flows.md'],
    });
    // 4. Holding up work, with a guided review the agent attached.
    const h1 = await opencode.send({ project_path: docs, body: DEMO_MESSAGES.holding });
    await opencode.submitGuide({ project_path: docs, snapshot: FIXTURE_V1_LOCAL, reply_to: h1.message_id, body: 'And here is the guided review of the token refresh change it depends on.' });
    // 5. New: news with a picture and a report.
    const n1 = await codex2.send({
      project_path: docs,
      subject: 'Link check passed',
      body: 'Run finished. The install page builds and every link checks out.\n\n![Link check](report/links.png)\n\nFull report attached. Preview deploy: https://docs-site-git-install-page.vercel.app/install',
      attachments: ['report/links.html'],
    });
    // 6. Stopped on you: the richest thread (pictures, files, two questions, a pick left unsent).
    const a1 = await claude.send({
      project_path: billing,
      subject: 'Stripe 409s: retry or dead-letter?',
      body: [
        'Thursday\'s deploy tripled the 409 conflicts from Stripe. Here is what it looks like:',
        '',
        '![409s per hour](shots/retries.png)',
        '',
        'Three invoices already sit in the dead-letter queue:',
        '',
        '![Dead-letter queue](shots/dlq.png)',
        '',
        'I wrote the plan and pulled the worker log; both are attached.',
      ].join('\n'),
      attachments: ['PLAN-retries.md', 'worker.log'],
    });
    const a2 = await claude.send({ project_path: billing, reply_to: a1.message_id, body: DEMO_MESSAGES.stopped });

    // The person's side.
    let t = await thread(s1.thread_id);
    let m = t.messages[0];
    let p = await pick(m.id, m.questions[0], ['Trust the webhook']);
    await api(`/api/inbox/messages/${m.id}/reply`, { idempotency_key: 'seed-s1', words: 'Webhook, but log every event we drop so we can replay.', questions: [{ key: p.key, revision: p.revision }] });

    t = await thread(c1.thread_id);
    m = t.messages[0];
    p = await pick(m.id, m.questions[0], ['iOS', 'Web']);
    await api(`/api/inbox/messages/${m.id}/reply`, { idempotency_key: 'seed-c1', words: 'Flow B. Ship iOS and web first, Android after the store review.', questions: [{ key: p.key, revision: p.revision }] });
    await pi.readThread(c1.thread_id);
    const c2 = await pi.send({ project_path: mobile, reply_to: m.id, body: 'Done: flow B is on for iOS and web in build 4.12. Android waits on the store review.' });
    await api(`/api/inbox/messages/${c2.message_id}/ack`, { ack: true });

    t = await thread(q1.thread_id);
    await api(`/api/inbox/messages/${t.messages[0].id}/ack`, { ack: true });

    // Thread 6: one pick saved but not sent, so the composer has something riding along.
    t = await thread(a1.thread_id);
    const asking = t.messages.find((x: Json) => x.id === a2.message_id);
    await pick(asking.id, asking.questions[0], ['Retry with the same idempotency key']);
    await api(`/api/inbox/threads/${a1.thread_id}/seen`, {});

    Object.assign(out, { stopped: a1.thread_id, holding: h1.thread_id, news: n1.thread_id, conversation: c1.thread_id, sent: s1.thread_id, quiet: q1.thread_id });
  } finally {
    await Promise.all([claude, claude2, opencode, pi, codex, codex2].map((a) => a.close()));
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
