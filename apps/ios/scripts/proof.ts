/**
 * The iPhone app's proof in action: a real Inbox, real agents, the real app.
 *
 * Starts a compiled `plannotator inbox --background` under a temp data dir,
 * connects agents through `plannotator inbox mcp` (scripts/inbox-sim.ts, the
 * MCP SDK's stdio client), makes a fresh simulator, and runs the app's
 * XCUITest flow (apps/ios/PlannotatorUITests) against that Inbox. The test
 * asks this script, over a loopback control server, for what only the
 * computer can do: make a pairing offer, have an agent write, hand back what
 * the agent's `wait_for_reply` received, remove the phone on the computer,
 * delete a thread on the computer, list the computer's devices, take a light
 * and a dark screenshot, set the text size, record the screen.
 *
 * The phone reaches the Inbox through a loopback proxy in front of it, so the
 * test can take the computer out of reach (`down`) or let a Send reach the
 * Inbox and then drop its answer (`drop-reply`), as a connection that dies
 * after the Inbox applied it.
 *
 *   bun apps/ios/scripts/proof.ts --binary .local/plannotator \
 *     [--device "iPhone 17"] [--shots .local/proof/ios] [--derived <DerivedData>] [--keep-simulator] [--only <test>]
 *
 * Every process runs with PLANNOTATOR_BROWSER=none and its own data dir; the
 * person's ~/.plannotator is never read.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../../scripts/inbox-sim.ts';
import { ClaudeSession } from '../../hook/hooks/mod/testing/claude-session.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repo = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const binary = resolve(flag('--binary', '.local/plannotator')!);
const deviceType = flag('--device', 'iPhone 17')!;
const shots = resolve(flag('--shots', join(repo, '.local/proof/ios'))!);
const derived = resolve(flag('--derived', join(tmpdir(), 'plannotator-ios-derived'))!);
const keepSimulator = args.includes('--keep-simulator');
// One test while working on it, e.g. --only PlannotatorUITests/AttachmentProofTests.
const only = flag('--only');

const tmp = mkdtempSync(join(tmpdir(), 'plannotator-ios-proof-'));
const dataDir = join(tmp, 'data');
mkdirSync(join(tmp, 'home'), { recursive: true });
mkdirSync(shots, { recursive: true });
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: join(tmp, 'home'),
  PLANNOTATOR_DATA_DIR: dataDir,
  PLANNOTATOR_BROWSER: 'none',
};
// Every plannotator process this script starts gets exactly this env: a temp data dir, never ~/.plannotator.
if (!env.PLANNOTATOR_DATA_DIR.startsWith(tmpdir()) || env.PLANNOTATOR_DATA_DIR.includes('/.plannotator')) {
  throw new Error(`Refusing to start an Inbox on ${env.PLANNOTATOR_DATA_DIR}: the proof runs on a temp data dir only.`);
}

function run(cmd: string, argv: string[], options: { env?: Record<string, string>; quiet?: boolean } = {}): string {
  const result = spawnSync(cmd, argv, { env: options.env ?? (process.env as Record<string, string>), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── The Inbox and its agents ───

run(binary, ['inbox', '--background'], { env });
const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const inbox = `http://127.0.0.1:${registry.port}`;
const windowRoute = (path: string, init: RequestInit = {}) =>
  fetch(`${inbox}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

const src = join(tmp, 'src');
const projects = Object.fromEntries(
  ['billing-svc', 'search-indexer', 'checkout-web', 'docs-site', 'ledger', 'api-gateway'].map((name) => [name, scratchProject(src, name)]),
);
const agent = (name: string, host: string) => SimAgent.connect({ binary, env, name, host });
const claude = await agent('Claude Code', 'claude-code');
const others = {
  claudeTests: await agent('Claude Code', 'claude-code'),
  claudeRefunds: await agent('Claude Code', 'claude-code'),
  pi: await agent('Pi', 'pi'),
  codex: await agent('Codex', 'codex'),
  opencode: await agent('OpenCode', 'opencode'),
};
// Every plannotator process this script starts gets exactly this env: a temp data dir, never ~/.plannotator.
if (!env.PLANNOTATOR_DATA_DIR.startsWith(tmpdir()) || env.PLANNOTATOR_DATA_DIR.includes('/.plannotator')) {
  throw new Error(`Refusing to start an Inbox on ${env.PLANNOTATOR_DATA_DIR}: the proof runs on a temp data dir only.`);
}

const question = (prompt: string, choices: string[], extra: string[] = []) =>
  [':::question', prompt, ...extra, '', ...choices.map((c) => `- [ ] ${c}`), `Recommended: ${choices[0]}`, ':::'].join('\n');

const newsAgents: SimAgent[] = [];
/** What each asking agent's wait_for_reply received, by thread. */
const replies = new Map<string, Promise<Record<string, unknown>>>();

// As an agent waits: call again after each "waiting", and after a client
// timeout (a slow CI runner can hold a call past the SDK's 60 s default).
async function waitForPersonReply(asker: SimAgent, threadId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const result = await asker.waitForReply(threadId, 25).catch((error: unknown) => {
      if (String(error).includes('timed out')) return { status: 'waiting' };
      throw error;
    });
    if (result.status !== 'waiting') return result;
  }
}

async function seed(): Promise<Record<string, string>> {
  const stopped = await claude.send({ project_path: projects['billing-svc']!, body: DEMO_MESSAGES.stopped, subject: 'Which way should the worker go on a Stripe 409?' });
  replies.set(stopped.thread_id as string, waitForPersonReply(claude, stopped.thread_id as string));
  await others.pi.send({ project_path: projects['search-indexer']!, body: ['The archive has 41 projects with stale indexes.', '', question('Reindex the archived projects now?', ['Reindex tonight', 'Leave them'], ['Holds up: the search page; the export; the archive banner.'])].join('\n'), subject: 'Reindex the archived projects now?' });
  const tests = await others.claudeTests.send({ project_path: projects['billing-svc']!, body: ['The retry worker is ready.', '', question('Run the retry tests against the Stripe test clock?', ['Yes', 'No'], ['They take about four minutes against the test key.'])].join('\n'), subject: 'Run the retry tests against the Stripe test clock?' });
  const refunds = await others.claudeRefunds.send({ project_path: projects['billing-svc']!, body: DEMO_MESSAGES.named, thread: 'refund-webhooks', subject: 'Refund events: trust the webhook or poll Stripe?' });
  await others.codex.send({ project_path: projects['checkout-web']!, body: ['Two ticket pages are built.', '', question('Which ticket page should I take forward?', ['The dark one', 'The light one'])].join('\n'), subject: 'Which ticket page should I take forward?' });
  await others.opencode.send({ project_path: projects['docs-site']!, body: ['## Install flow', '', 'The flow now **detects** the agent first, then asks.', '', '- one command', '- one prompt', '', question('Is this the install flow you want?', ['Yes', 'No'])].join('\n'), subject: 'Is this the install flow you want?' });
  for (const [name, text] of [
    ['ledger', 'Run finished. A guided review of the export is next.'],
    ['api-gateway', 'Run finished. The rate headers are back on every route.'],
    ['docs-site', 'Run finished. The install page builds and its links check out.'],
  ] as const) {
    // One session per project, so each news line is its own thread.
    const writer = await agent('Claude Code', 'claude-code');
    newsAgents.push(writer);
    await writer.send({ project_path: projects[name]!, body: text });
  }
  replies.set(tests.thread_id as string, waitForPersonReply(others.claudeTests, tests.thread_id as string));
  replies.set(refunds.thread_id as string, waitForPersonReply(others.claudeRefunds, refunds.thread_id as string));
  return { stopped: stopped.thread_id as string, tests: tests.thread_id as string, refunds: refunds.thread_id as string };
}

async function more(): Promise<Record<string, string>> {
  // New sessions, so each message starts its own thread.
  const codex = await agent('Codex', 'codex');
  const opencode = await agent('OpenCode', 'opencode');
  newsAgents.push(codex, opencode);
  const ship = await codex.send({ project_path: projects['checkout-web']!, body: question('Ship the dark ticket page behind a flag?', ['Yes', 'No']), subject: 'Ship the dark ticket page behind a flag?' });
  const keep = await opencode.send({ project_path: projects['docs-site']!, body: question('Keep the old install page for a week?', ['Yes', 'No']), subject: 'Keep the old install page for a week?' });
  return { ship: ship.thread_id as string, keep: keep.thread_id as string };
}

// ─── M3: decisions, and New message to live Claude Code sessions ───
//
// The live sessions are the Claude Code mod's own code on real processes,
// HTTP and files (apps/hook/hooks/mod/testing/claude-session.ts, the mod
// harness the Inbox's Claude Code proofs use): each polls the Inbox's bridge
// from its project, so the Inbox counts it live, and a New message wakes it
// as a turn. Pi writes through the MCP like the other agents and never polls,
// so its project has no live session (8.3).

const m3Bin = join(tmp, 'bin');
mkdirSync(m3Bin, { recursive: true });
writeFileSync(join(m3Bin, 'plannotator'), `#!/bin/sh\nexec '${binary}' "$@"\n`);
chmodSync(join(m3Bin, 'plannotator'), 0o755);
const m3Env = { ...env, PATH: `${m3Bin}:${env.PATH}` };
const m3Sessions = new Map<string, { session: ClaudeSession; cwd: string }>();
const m3Agents: SimAgent[] = [];
const m3Threads: string[] = [];

async function m3Seed(): Promise<Record<string, string>> {
  const billing = projects['billing-svc']!;
  const writer = await agent('Claude Code', 'claude-code');
  const tests = await agent('Claude Code', 'claude-code');
  const refunds = await agent('Claude Code', 'claude-code');
  const pi = await agent('Pi', 'pi');
  m3Agents.push(writer, tests, refunds, pi);
  const decide = await writer.send({
    project_path: billing,
    subject: 'Which way should the worker go on a Stripe 409?',
    body: ['I checked the 409 row against the Stripe docs. Two things before I go on.', '', question('Which way should the worker go on a Stripe 409?', ['Retry with the same idempotency key', 'Fail the job and send it to the dead-letter queue']), '', question('Ship the retry worker behind a flag?', ['Yes', 'No'])].join('\n'),
  });
  const noDecision = await tests.send({ project_path: billing, subject: 'Run the retry tests against the Stripe test clock?', body: question('Run the retry tests against the Stripe test clock?', ['Yes', 'No'], ['They take about four minutes against the test key.']) });
  // Waits on a call: the block itself asks for a decision once answered.
  const waits = await refunds.send({ project_path: billing, subject: 'Refund events: trust the webhook or poll Stripe?', body: question('Refund events: trust the webhook or poll Stripe?', ['Trust the webhook', 'Poll Stripe every minute'], ['Decision: when answered']) });
  // What already holds, and one decision retired, as the record's 5.2 draws the page.
  await writer.recordDecision({ project_path: billing, text: 'The worker never refunds on its own; refunds stay a person\'s call.' });
  await writer.recordDecision({ project_path: billing, text: 'Webhooks are verified before any database write.' });
  const old = await writer.recordDecision({ project_path: billing, text: 'Failed charges wait an hour before a retry.' });
  const oldDecision = (old.decision ?? old) as { id: string; version: number };
  const retired = await windowRoute(`/api/inbox/decisions/${oldDecision.id}/retire`, { method: 'POST', body: JSON.stringify({ version: oldDecision.version }) });
  if (!retired.ok) throw new Error(`retire: ${retired.status} ${await retired.text()}`);
  const piThread = await pi.send({
    project_path: projects['search-indexer']!,
    subject: 'Run finished. The archived projects are reindexed.',
    body: 'Run finished. The 41 archived projects are reindexed and the search page reads them again.',
  });

  const ids = { decide: decide.thread_id, no_decision: noDecision.thread_id, waits: waits.thread_id, pi: piThread.thread_id } as Record<string, string>;
  m3Threads.push(...Object.values(ids));
  return ids;
}

/** Live Claude Code sessions: two in ledger (one writes the thread), one in api-gateway. */
async function m3Live(): Promise<Record<string, string>> {
  const live = async (name: string, project: string) => {
    const session = await ClaudeSession.start({ env: m3Env, cwd: project, store: new Map(), sessionId: crypto.randomUUID(), dataDir });
    if (!session.inboxTools) throw new Error('the mod found no Inbox');
    m3Sessions.set(name, { session, cwd: project });
    return session;
  };
  const say = async (session: ClaudeSession, cwd: string, body: string) => {
    const answer = await session.callInbox({ action: 'send_message', body }, cwd);
    if ('deny' in answer) throw new Error(answer.deny);
    return (JSON.parse(answer.text.slice(answer.text.indexOf('{'))) as { thread_id: string }).thread_id;
  };
  const ledgerWriter = await live('ledger-writer', projects['ledger']!);
  const ledger = await say(ledgerWriter, projects['ledger']!, 'Run finished. The export now streams rows to the file instead of building it in memory.');
  await live('ledger-other', projects['ledger']!);
  const gatewaySession = await live('gateway', projects['api-gateway']!);
  const gateway = await say(gatewaySession, projects['api-gateway']!, 'Run finished. The CSV export endpoint is behind the gateway now.');
  for (const [thread, count] of [[ledger, 2], [gateway, 1]] as const) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const model = (await (await windowRoute(`/api/inbox/threads/${thread}/sessions`)).json()) as { sessions: unknown[] };
      if (model.sessions.length === count) break;
      if (Date.now() > deadline) throw new Error(`${count} live sessions for ${thread}: ${JSON.stringify(model)}`);
      await sleep(250);
    }
  }
  m3Threads.push(ledger, gateway);
  return { ledger, gateway, ledger_writer_session: ledgerWriter.sessionId };
}

/** A live session's wake for the person's New message, and its answer in the same thread. */
async function m3Turn(who: string): Promise<Record<string, unknown>> {
  const target = m3Sessions.get(who);
  if (!target) throw new Error(`no session ${who}`);
  const deadline = Date.now() + 60_000;
  while (target.session.host.submits.length === 0) {
    if (Date.now() > deadline) throw new Error(`no New message turn in ${who}`);
    await sleep(200);
  }
  const wake = target.session.host.submits.at(-1)!;
  const id = /\((msg_[0-9A-Z]+)\)$/.exec(wake.split('\n')[0]!)?.[1];
  if (!id) throw new Error(`a wake with no id: ${wake.split('\n')[0]}`);
  const answer = await target.session.callInbox({ action: 'send_message', reply_to: id, body: 'Added the header row: an empty ledger now exports a valid CSV.' }, target.cwd);
  if ('deny' in answer) throw new Error(answer.deny);
  await sleep(1500); // a wrong delivery would land in another session now
  return { wake: wake.split('\n')[0], submits: Object.fromEntries([...m3Sessions].map(([name, s]) => [name, s.session.host.submits.length])) };
}

/** What the desktop window's Decisions page reads for the thread's project (its own route). */
async function m3Decisions(thread: string): Promise<Record<string, unknown>> {
  const { thread: t } = (await (await windowRoute(`/api/inbox/threads/${thread}`)).json()) as { thread: { project: { id: string } } };
  const model = (await (await windowRoute(`/api/inbox/decisions?project=${t.project.id}`)).json()) as {
    decisions: { text: string; state: string; source: { thread_id: string | null } }[];
  };
  return {
    of_thread: model.decisions.filter((d) => d.source.thread_id === thread).map((d) => ({ text: d.text, state: d.state })),
    current: model.decisions.filter((d) => d.state === 'current').map((d) => d.text).reverse(),
  };
}

async function m3Close(): Promise<void> {
  for (const { session } of m3Sessions.values()) session.quit();
  m3Sessions.clear();
  await Promise.allSettled(m3Agents.splice(0).map((a) => a.close()));
}

async function m3Cleanup(): Promise<void> {
  await m3Close();
  for (const thread of m3Threads.splice(0)) await windowRoute(`/api/inbox/threads/${thread}/delete`, { method: 'POST', body: '{}' });
}

// M2: one message with three files to comment on (the record's 4.1, 4.3 and 4.4).
const fixtures = join(repo, 'apps/ios/scripts/fixtures');
let filesAgent: SimAgent | null = null;
const beacons: string[] = [];
let planPath = '';

async function attach(): Promise<Record<string, string>> {
  const project = projects['billing-svc']!;
  mkdirSync(join(project, 'plans'), { recursive: true });
  planPath = join(project, 'plans', 'retry-plan.md');
  for (const [from, to] of [
    ['retry-plan.md', planPath],
    ['ticket-page.html', join(project, 'ticket-page.html')],
    ['install-flow.mmd', join(project, 'install-flow.mmd')],
  ] as const) copyFileSync(join(fixtures, from), to);
  // The ticket page's photos, from its own folder: one name with a space, one with an accent.
  cpSync(join(fixtures, 'going'), join(project, 'going'), { recursive: true });
  // A page the ticket page embeds from its folder, which tries to reach this script's beacon.
  writeFileSync(join(project, 'venue-notes.html'), readFileSync(join(fixtures, 'venue-notes.html'), 'utf8').replace('__PROOF_BEACON__', `http://127.0.0.1:${control.port}/beacon`));
  filesAgent = await agent('Claude Code', 'claude-code');
  const sent = await filesAgent.send({
    project_path: project,
    subject: 'Three files for the retry work',
    body: 'The retry plan, the ticket page and the install flow are attached. Comment on anything that looks wrong.',
    attachments: ['plans/retry-plan.md', 'ticket-page.html', 'install-flow.mmd'],
  });
  const thread = sent.thread_id as string;
  replies.set(thread, waitForPersonReply(filesAgent, thread));
  return { thread };
}

// ─── The door, through a proxy the test can break ───

let proxyMode: 'pass' | 'down' | 'drop-reply' = 'pass';
/** A response that never completes: the connection dies, as a network drop does. */
const dropped = () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error('dropped')) }));
const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (proxyMode === 'down') return dropped();
    const forwarded = await fetch(`${inbox}${url.pathname}${url.search}`, {
      method: request.method,
      headers: [...request.headers].filter(([name]) => !['host', 'connection', 'content-length'].includes(name.toLowerCase())),
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    });
    if (proxyMode === 'drop-reply' && request.method === 'POST' && url.pathname.endsWith('/reply')) {
      // The Inbox applied the Send; the phone never hears the answer.
      proxyMode = 'pass';
      await forwarded.arrayBuffer();
      return dropped();
    }
    return new Response(forwarded.body, { status: forwarded.status, headers: forwarded.headers });
  },
});

// ─── The simulator ───

const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes as { identifier: string; platform: string; isAvailable: boolean; version: string }[];
const runtime = runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1);
if (!runtime) throw new Error('No iOS simulator runtime is installed.');
const udid = run('xcrun', ['simctl', 'create', `plannotator-proof-${process.pid}`, deviceType, runtime.identifier]).trim();
run('xcrun', ['simctl', 'boot', udid]);
run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
run('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '10:52', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularBars', '4']);
run('xcrun', ['simctl', 'ui', udid, 'appearance', 'light']);

let video: ChildProcess | null = null;

async function shot(name: string): Promise<void> {
  run('xcrun', ['simctl', 'io', udid, 'screenshot', join(shots, `${name}-light.png`)]);
  run('xcrun', ['simctl', 'ui', udid, 'appearance', 'dark']);
  await sleep(1200);
  run('xcrun', ['simctl', 'io', udid, 'screenshot', join(shots, `${name}-dark.png`)]);
  run('xcrun', ['simctl', 'ui', udid, 'appearance', 'light']);
  await sleep(900);
}

// ─── The control server the test calls ───

const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, string>) : {};
    try {
      switch (path) {
        case '/seed':
          return Response.json(await seed());
        case '/more':
          return Response.json(await more());
        case '/reset-app': {
          // After a proof class: the app's stored sources and caches go, as a fresh install has none.
          spawnSync('xcrun', ['simctl', 'spawn', udid, 'defaults', 'delete', 'ai.plannotator.app']);
          const container = spawnSync('xcrun', ['simctl', 'get_app_container', udid, 'ai.plannotator.app', 'data'], { encoding: 'utf8' }).stdout.trim();
          if (container.startsWith('/')) rmSync(join(container, 'Library', 'Caches', 'inbox'), { recursive: true, force: true });
          return Response.json({ ok: true });
        }
        case '/attach':
          return Response.json(await attach());
        case '/beacon':
          // Anything an agent's page managed to send out of the phone's surface.
          beacons.push(new URL(request.url).search);
          return new Response('', { status: 204 });
        case '/beacons':
          return Response.json({ count: beacons.length, hits: beacons });
        case '/edit-plan': {
          // The agent edits the plan after the person commented: the file on disk is no longer what was sent.
          const text = readFileSync(planPath, 'utf8').replace('at the end of the first week.', 'at the end of the first two weeks.');
          writeFileSync(planPath, text);
          return Response.json({ ok: true });
        }
        case '/proxy':
          proxyMode = body.mode as typeof proxyMode;
          return Response.json({ mode: proxyMode });
        case '/delete-on-computer': {
          const answer = await windowRoute(`/api/inbox/threads/${body.thread}/delete`, { method: 'POST', body: '{}' });
          return Response.json({ ok: answer.ok }, { status: answer.ok ? 200 : 500 });
        }
        case '/person-replies': {
          // How many replies of the person's the thread holds on the computer.
          const answer = (await (await windowRoute(`/api/inbox/threads/${body.thread}`)).json()) as { thread: { messages: { author: { kind: string } }[] } };
          return Response.json({ count: answer.thread.messages.filter((m) => m.author.kind === 'person').length });
        }
        case '/pair-link': {
          // A live offer's own link, pointed at the proxy: what the Camera app would open.
          const answer = await windowRoute('/api/inbox/pairing', { method: 'POST', body: '{}' });
          const offer = (await answer.json()) as { link: string; computer: { name: string } };
          if (!answer.ok) throw new Error(`pairing offer: ${answer.status}`);
          const link = new URL(offer.link);
          // The test may stand in a hostile link: a name that reads like an
          // address, or an address with user info in it.
          link.searchParams.set('tailnet', body.tailnet ?? `127.0.0.1:${proxy.port}`);
          if (body.name) link.searchParams.set('name', body.name);
          link.searchParams.delete('lan');
          link.searchParams.delete('fp');
          return Response.json({ url: link.toString(), address: `127.0.0.1:${proxy.port}`, name: offer.computer.name });
        }
        case '/link-message': {
          // An agent's message carrying a live pairing link as a markdown link.
          const answer = await windowRoute('/api/inbox/pairing', { method: 'POST', body: '{}' });
          const offer = (await answer.json()) as { link: string };
          const link = new URL(offer.link);
          link.searchParams.set('tailnet', `127.0.0.1:${proxy.port}`);
          const writer = await agent('Claude Code', 'claude-code');
          newsAgents.push(writer);
          const sent = await writer.send({ project_path: projects['ledger']!, subject: 'The export diff is ready', body: `The export changed in two files. [open the diff](${link.toString()}) when you can.` });
          return Response.json({ thread: sent.thread_id });
        }
        case '/open-url':
          run('xcrun', ['simctl', 'openurl', udid, body.url ?? '']);
          return Response.json({ ok: true });
        case '/text-size':
          // The simulator's Dynamic Type size, e.g. accessibility-extra-extra-extra-large, then large.
          run('xcrun', ['simctl', 'ui', udid, 'content_size', body.size ?? 'large']);
          await sleep(1500);
          return Response.json({ ok: true });
        case '/offer': {
          const answer = await windowRoute('/api/inbox/pairing', { method: 'POST', body: '{}' });
          const offer = (await answer.json()) as { offer: { code: string } };
          if (!answer.ok) throw new Error(`pairing offer: ${answer.status} ${JSON.stringify(offer)}`);
          return Response.json({ address: `127.0.0.1:${proxy.port}`, code: offer.offer.code });
        }
        case '/reply': {
          // What the asking agent's wait_for_reply received for that thread.
          const result = await Promise.race([replies.get(body.thread ?? '') ?? Promise.resolve(null), sleep(90_000).then(() => null)]);
          return Response.json(result ?? { error: 'no reply within 90 s' }, { status: result ? 200 : 504 });
        }
        case '/devices':
          return new Response((await windowRoute('/api/inbox/devices')).body, { headers: { 'Content-Type': 'application/json' } });
        case '/remove-on-computer': {
          const { devices } = (await (await windowRoute('/api/inbox/devices')).json()) as { devices: { id: string }[] };
          for (const device of devices) await windowRoute(`/api/inbox/devices/${device.id}/revoke`, { method: 'POST', body: '{}' });
          return Response.json({ removed: devices.length });
        }
        case '/m3-seed':
          return Response.json(await m3Seed());
        case '/m3-live':
          return Response.json(await m3Live());
        case '/m3-turn':
          return Response.json(await m3Turn(body.who ?? ''));
        case '/m3-decisions':
          return Response.json(await m3Decisions(body.thread ?? ''));
        case '/m3-dark':
          // A menu or a popover opened while the simulator is already dark (switching under an open one leaves it light).
          if (body.snap) run('xcrun', ['simctl', 'io', udid, 'screenshot', join(shots, `${body.snap}-dark.png`)]);
          run('xcrun', ['simctl', 'ui', udid, 'appearance', body.on === 'true' ? 'dark' : 'light']);
          await sleep(1200);
          return Response.json({ ok: true });
        case '/m3-cleanup':
          await m3Cleanup();
          return Response.json({ ok: true });
        case '/shot':
          await shot(body.name ?? 'shot');
          return Response.json({ ok: true });
        case '/video/start':
          video = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec', 'h264', '--force', join(shots, `${body.name ?? 'flow'}.mp4`)], { stdio: 'ignore' });
          await sleep(1500);
          return Response.json({ ok: true });
        case '/video/stop':
          video?.kill('SIGINT');
          await new Promise((r) => (video ? video.once('exit', r) : r(null)));
          video = null;
          return Response.json({ ok: true });
        default:
          return Response.json({ error: 'unknown' }, { status: 404 });
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
});

// ─── The test ───

let status = 1;
// Build once, then WarmUpLaunch alone: the app's first launch and first pairing
// on this fresh simulator, which a cold CI runner makes take a minute or more,
// so every proof class after it starts warm (PlannotatorUITests/WarmUpLaunch.swift).
const xcodebuild = (args: string[]) =>
  new Promise<number>((r) =>
    spawn('xcodebuild', [...args, '-project', join(repo, 'apps/ios/Plannotator.xcodeproj'), '-scheme', 'Plannotator', '-destination', `id=${udid}`, '-derivedDataPath', derived], {
      stdio: 'inherit',
      env: { ...process.env, TEST_RUNNER_PROOF_CONTROL: `http://127.0.0.1:${control.port}` },
    }).once('exit', (code) => r(code ?? 1)),
  );
const warmUp = 'PlannotatorUITests/WarmUpLaunch';
try {
  status = await xcodebuild(['build-for-testing']);
  // The warm-up pays a cost, it proves nothing: it never fails the proof. On a cold
  // runner its first try can itself time out inside XCTest (run 37815033252 attempt 2:
  // the pairing cover took over 120 s to first appear), so it gets a second try.
  for (let attempt = 1; status === 0 && attempt <= 2; attempt++) {
    const warm = await xcodebuild(['test-without-building', `-only-testing:${warmUp}`, '-resultBundlePath', join(tmp, `WarmUp-${attempt}.xcresult`)]);
    process.stdout.write(`\nWarm-up ${attempt}: ${warm === 0 ? 'done' : 'did not finish, the app is still warming'}\n`);
    if (warm === 0) break;
  }
  if (status === 0) status = await xcodebuild(['test-without-building', ...(only ? [`-only-testing:${only}`] : [`-skip-testing:${warmUp}`]), '-resultBundlePath', join(tmp, 'Proof.xcresult')]);
} finally {
  video?.kill('SIGINT');
  await m3Close();
  control.stop(true);
  proxy.stop(true);
  await Promise.allSettled([claude, ...Object.values(others), ...newsAgents, ...(filesAgent ? [filesAgent] : [])].map((a) => a.close()));
  await fetch(`${inbox}/api/inbox/control/stop`, { method: 'POST', headers: { Authorization: `Bearer ${registry.token}` } }).catch(() => {});
  if (status !== 0) {
    // A crash of the app leaves its report with the simulator's host; keep it with the frames.
    const reports = join(process.env.HOME ?? '', 'Library/Logs/DiagnosticReports');
    for (const name of spawnSync('ls', [reports], { encoding: 'utf8' }).stdout.split('\n').filter((n) => n.startsWith('Plannotator'))) {
      spawnSync('cp', [join(reports, name), shots]);
    }
  }
  if (!keepSimulator) spawnSync('xcrun', ['simctl', 'delete', udid]);
  if (status === 0) rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`\nKept for a look: ${tmp} (Proof.xcresult, the Inbox's data dir)\n`);
}
process.stdout.write(`\nScreenshots and the recording: ${shots}\n`);
process.exit(status);
