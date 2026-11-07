/**
 * The world of the search type filter's proofs (approval
 * "inbox-search-type-filter"), the store its design pictures were made from:
 * four agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts)
 * about a push relay, in five projects, and one reply by the person. "relay"
 * matches six threads (one more than the Threads cap), ten files (twice the
 * Files cap), two projects and a dozen messages. Used by
 * inbox-search-type-filter.spec.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

export interface TypeWorld {
  agents: SimAgent[];
  /** The ten attachments whose names say "relay" (the Files a "relay" query finds). */
  relayFiles: number;
  /** Add a thread in a project with a 54-character name (the filter row's worst case); returns the name. */
  longProject: () => Promise<string>;
}

const ask = (prompt: string, choices: string[]) => ['', ':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

/** Write a file into a project and return its path (an agent attaches it). */
function file(project: string, path: string, text: string): string {
  const full = join(project, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text);
  return full;
}

async function personReply(url: string, messageId: string, words: string): Promise<void> {
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  const response = await fetch(new URL(`/api/inbox/messages/${messageId}/reply`, url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotency_key: `k-${messageId}`, words, serverSession: health.serverSession }),
  });
  if (!response.ok) throw new Error(`reply: ${response.status} ${await response.text()}`);
}

export async function seedTypeWorld(input: { binary: string; env: Record<string, string>; root: string; url: string }): Promise<TypeWorld> {
  const src = join(input.root, 'src');
  const p = {
    relay: scratchProject(src, 'relay'),
    worker: scratchProject(src, 'relay-push-worker'),
    plannotator: scratchProject(src, 'plannotator'),
    marketing: scratchProject(src, 'marketing-site'),
    workspaces: scratchProject(src, 'workspaces'),
  };
  const claude = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'Claude Code', host: 'claude-code' });
  const pi = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'Pi', host: 'pi' });
  const opencode = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'OpenCode', host: 'opencode' });
  const codex = await SimAgent.connect({ binary: input.binary, env: input.env, name: 'Codex', host: 'codex' });
  const pause = () => new Promise((r) => setTimeout(r, 15));
  const msg = (sent: Record<string, unknown>) => sent.message_id as string;

  await pi.send({ project_path: p.workspaces, subject: 'Comments table migration', thread: 'comments-migration', body: 'The migration adds resolved_at and an index on (document_id, created_at). It runs in 4 s on a copy of production.' });
  await pause();
  await claude.send({ project_path: p.marketing, subject: 'Copy for the mobile page', thread: 'mobile-page', body: 'Draft for the top of the mobile page. It explains the relay in one line: your phone and your Inbox talk through it, and it never keeps a message.' });
  await pause();
  await codex.send({
    project_path: p.plannotator,
    subject: 'Relay quota for free accounts',
    thread: 'relay-quota',
    body: `A free account gets 500 relay pushes a day; past that, pushes wait for the next poll.${ask('Ship the free relay quota at 500 pushes a day?', ['500 a day', '1,000 a day', 'No quota yet'])}`,
    attachments: [file(p.plannotator, 'docs/relay-quota-proposal.md', '# Relay quota\n')],
  });
  await pause();
  await claude.send({
    project_path: p.plannotator,
    subject: 'Phone pairing through the relay',
    thread: 'phone-pairing',
    body: 'Pairing now goes through the relay: the phone scans the code, the relay opens a mailbox, and the Inbox answers on it. No port is opened on the Mac.',
    attachments: [file(p.plannotator, 'docs/pairing-via-relay.md', '# Pairing\n'), file(p.plannotator, 'screens/relay-pairing-flow.html', '<h1>Pairing</h1>\n')],
  });
  await pause();
  await codex.send({
    project_path: p.worker,
    subject: 'Relay worker deploy to Cloudflare',
    thread: 'relay-deploy',
    body: 'Deployed the relay worker to production. Durable Objects migrated with no downtime; the old worker drains for ten minutes.',
    attachments: [file(p.worker, 'deploy/relay-deploy-notes.md', '# Deploy notes\n')],
  });
  await pause();
  await opencode.send({
    project_path: p.relay,
    subject: 'Rotate the relay signing key',
    thread: 'relay-keys',
    body: 'The new key signs from today. Phones on 0.28.40 and later verify either relay key, so nothing breaks during the overlap.',
    attachments: [file(p.relay, 'ops/relay-key-rotation.md', '# Key rotation\n'), file(p.relay, 'src/relay-signing.ts', 'export const sign = () => {};\n')],
  });
  await pause();
  await claude.send({
    project_path: p.relay,
    subject: 'Relay handshake drops the first push after a reconnect',
    thread: 'relay-handshake',
    body: `The first push after a reconnect is lost: the relay acks it before the socket is ready. I added a test: reconnect during a push, the relay delivers it once.${ask('Hold pushes on the relay until the handshake ends?', ['Hold them', 'Drop and resend'])}`,
    attachments: [file(p.relay, 'docs/relay-handshake-trace.md', '# Trace\n'), file(p.relay, 'logs/relay-reconnect-2026-10-30.log', 'reconnect\n')],
  });
  await pause();
  const latency = await claude.send({
    project_path: p.worker,
    subject: 'Relay push latency on Android',
    thread: 'relay-latency',
    body: 'Android pushes through the relay take 2.4 s at p95, against 0.6 s on iOS. Normal-priority FCM messages wait for the doze window.',
    attachments: [file(p.worker, 'bench/relay-latency.json', '{"p95": 2.4}\n'), file(p.worker, 'bench/relay-latency-android.html', '<h1>Latency</h1>\n')],
  });
  await personReply(input.url, msg(latency), 'Good. Keep the relay on high priority only for questions.');

  return {
    agents: [claude, pi, opencode, codex],
    relayFiles: 10,
    longProject: async () => {
      const name = 'northwind-industries-holdings-customer-portal-frontend';
      await claude.send({ project_path: scratchProject(src, name), subject: 'Relay webhook for the customer portal', thread: 'portal-webhook', body: 'The customer portal now gets relay webhooks for new orders.' });
      return name;
    },
  };
}
