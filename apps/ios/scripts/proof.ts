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
 *     [--device "iPhone 17"] [--shots .local/proof/ios] [--derived <DerivedData>] [--keep-simulator]
 *     [--only PlannotatorUITests/RelayPushTests]
 *
 * Every process runs with PLANNOTATOR_BROWSER=none and its own data dir; the
 * person's ~/.plannotator is never read.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { dirname, join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../../scripts/inbox-sim.ts';
import { GUIDE_BRIEF_EXAMPLE } from '../../../packages/server/inbox-guides.ts';
import { deriveRelayKeys } from '../../../packages/core/crypto.ts';

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
/** Run one test class or method (`PlannotatorUITests/RelayPushTests`), for a reviewer re-running a part. */
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

function run(cmd: string, argv: string[], options: { env?: Record<string, string>; quiet?: boolean } = {}): string {
  const result = spawnSync(cmd, argv, { env: options.env ?? (process.env as Record<string, string>), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── M5: the relay under wrangler dev, and Apple played locally ───
//
// The Inbox posts its pushes to the relay (apps/relay under `wrangler dev`,
// as R1's proof runs it); the relay sends them over HTTP/2 to a local server
// standing in for APNs, which keeps each body. The notification test hands
// that exact body to `xcrun simctl push`. The APNs key is made for this run
// and lives only in the relay's env file under the temp dir.

interface Pushed { path: string; collapseId: string; body: string }
const pushes: Pushed[] = [];
/** The file holding each thread's latest push body, for `simctl push`. */
const pushFiles = new Map<string, string>();
const apple = http2.createServer();
apple.on('stream', (stream: http2.ServerHttp2Stream, headers) => {
  let body = '';
  stream.on('data', (chunk) => (body += chunk));
  stream.on('end', () => {
    pushes.push({ path: String(headers[':path']), collapseId: String(headers['apns-collapse-id']), body });
    stream.respond({ ':status': 200, 'apns-id': crypto.randomUUID() });
    stream.end();
  });
});
await new Promise<void>((ready) => apple.listen(0, '127.0.0.1', () => ready()));

const freePort = () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
};
const relayDir = join(repo, 'apps/relay');
const relayState = join(tmp, 'relay');
mkdirSync(relayState, { recursive: true });
const apnsKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
writeFileSync(
  join(relayState, 'relay.env'),
  [
    `APNS_KEY=${Buffer.from(await crypto.subtle.exportKey('pkcs8', apnsKey.privateKey)).toString('base64')}`,
    'APNS_KEY_ID=KEY0000000',
    'APNS_TEAM_ID=TEAM000000',
    `APNS_ORIGIN=http://127.0.0.1:${(apple.address() as { port: number }).port}`,
  ].join('\n') + '\n',
  { mode: 0o600 },
);
const relayPort = freePort();
const relayUrl = `http://127.0.0.1:${relayPort}`;
const relayLog: string[] = [];
const relay = spawn(
  join(relayDir, 'node_modules/.bin/wrangler'),
  ['dev', '--local', '--ip', '127.0.0.1', '--port', String(relayPort), '--inspector-port', String(freePort()), '--persist-to', relayState, '--env-file', join(relayState, 'relay.env'), '--show-interactive-dev-session=false'],
  { cwd: relayDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
for (const stream of [relay.stdout, relay.stderr]) stream?.on('data', (chunk) => relayLog.push(String(chunk)));
for (let tries = 0; ; tries++) {
  const status = await fetch(`${relayUrl}/v1/nothing`).then((r) => r.status).catch(() => 0);
  if (status === 404) break;
  if (tries > 600) throw new Error(`wrangler dev did not start:\n${relayLog.join('')}`);
  await sleep(100);
}
// Warm the relay: the first request to a Durable Object under wrangler dev
// builds it, which on a CI runner can hold the Inbox's first pairing (it
// registers the phone at the relay before it answers) past the test's waits.
await fetch(`${relayUrl}/v1/mailboxes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret_sha256: '0'.repeat(64) }) }).catch(() => {});
env.PLANNOTATOR_RELAY_URL = relayUrl;

/** The relay's stored devices, read from its Durable Object's SQLite file (as R1's proof reads them). */
function relayDevices(): Record<string, unknown>[] {
  const dir = join(relayState, 'v3', 'do', 'plannotator-relay-Mailbox');
  if (!existsSync(dir)) return [];
  const rows: Record<string, unknown>[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')) {
    // wrangler dev holds the file open and writes it; a read that misses is
    // skipped here, and the test reads again (it polls).
    try {
      const db = new Database(join(dir, file), { readonly: true });
      try {
        const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        if (tables.includes('devices')) rows.push(...(db.query('SELECT id, carriage, apns_token, apns_environment FROM devices').all() as Record<string, unknown>[]));
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return rows;
}

// ─── The Inbox and its agents ───

// A harness proves its data dir before it spawns (row 5109): a temp path, never ~/.plannotator.
if (!realpathSync(dataDir.replace(/\/data$/, '')).startsWith(realpathSync(tmpdir()))) throw new Error(`not a temp data dir: ${dataDir}`);
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

// ─── The door, through a proxy the test can break ───

// 'gone': what `tailscale serve` answers when nothing listens behind it (502), for M5's lock-screen answer.
let proxyMode: 'pass' | 'down' | 'drop-reply' | 'gone' = 'pass';
/** A response that never completes: the connection dies, as a network drop does. */
const dropped = () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error('dropped')) }));
const proxy = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);
    if (proxyMode === 'down') return dropped();
    if (proxyMode === 'gone') return new Response('Bad Gateway', { status: 502 });
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
        // ── M5: the relay and the pushes ──
        case '/relay':
          // The relay's stored devices: registered at pairing, then the APNs token.
          return Response.json({ devices: relayDevices() });
        case '/ask': {
          // An agent's message lands; the Inbox pushes through the relay to Apple, played
          // locally. Answers the thread and the exact body Apple received for it.
          const before = pushes.length;
          const writer = await agent(body.agent ?? 'Claude Code', body.host ?? 'claude-code');
          newsAgents.push(writer);
          let sent: Record<string, unknown>;
          if (body.kind === 'guide') {
            sent = await writer.submitGuide({ ...GUIDE_BRIEF_EXAMPLE, project_path: projects['ledger']!, subject: 'Run finished. A guided review of the export change is attached.' });
          } else if (body.kind === 'ship') {
            sent = await writer.send({ project_path: projects['checkout-web']!, subject: 'Ship the dark ticket page behind a flag?', body: question('Ship the dark ticket page behind a flag?', ['Yes', 'No']) });
          } else {
            sent = await writer.send({ project_path: projects['billing-svc']!, subject: 'Run the retry tests against the Stripe test clock?', body: ['The retry worker is ready.', '', question('Run the retry tests against the Stripe test clock?', ['Yes', 'No'], ['They take about four minutes against the test key.'])].join('\n') });
          }
          const thread = sent.thread_id as string;
          replies.set(thread, waitForPersonReply(writer, thread));
          for (let tries = 0; pushes.length === before; tries++) {
            if (tries > 300) throw new Error(`no push reached Apple for ${thread}`);
            await sleep(100);
          }
          const pushed = pushes.at(-1)!;
          // Files named by this script, never by the request: the nth push, kept for /push and for the record.
          const file = join(tmp, `push-${pushes.length}.json`);
          writeFileSync(file, pushed.body);
          writeFileSync(join(shots, `M5-push-${pushes.length}.json`), pushed.body);
          pushFiles.set(thread, file);
          return Response.json({ thread, bytes: pushed.body.length, collapse_id: pushed.collapseId, device_token: pushed.path.split('/').at(-1) });
        }
        case '/relay-log':
          // How many commands the relay queued: a lock-screen answer that went up through it.
          return Response.json({ queued: relayLog.join('').split('relay: command ').filter((line) => line.includes(' queued')).length });
        case '/push': {
          // The exact body Apple received for that thread, delivered to the simulator.
          const file = pushFiles.get(body.thread ?? '');
          if (!file) return Response.json({ error: 'no push for that thread' }, { status: 404 });
          run('xcrun', ['simctl', 'push', udid, 'ai.plannotator.app', file]);
          return Response.json({ ok: true });
        }
        case '/relay-token-stand-in': {
          // A simulator that cannot reach APNs (a CI runner) never gets a token:
          // register a stand-in for each paired phone at the relay, as the phone
          // would (7.29, its relay secret derived from the pairing secret the
          // computer keeps), so the pushes still go out. The brief allows a fake
          // token for the registration call; the test says which it used.
          const mailbox = JSON.parse(readFileSync(join(dataDir, 'inbox', 'relay.json'), 'utf8')) as { url: string; mailbox_id: string };
          const token = 'a'.repeat(64);
          let registered = 0;
          // The paired phones as the computer lists them (the relay's storage file can miss a read while wrangler writes it).
          const { devices } = (await (await windowRoute('/api/inbox/devices')).json()) as { devices: { id: string }[] };
          for (const device of devices) {
            const id = device.id;
            const secret = readFileSync(join(dataDir, 'inbox', 'device-secrets', id.replace(/[^A-Za-z0-9_]/g, '')), 'utf8').trim();
            const { relaySecret } = await deriveRelayKeys(secret, id);
            const answer = await fetch(`${mailbox.url}/v1/mailboxes/${mailbox.mailbox_id}/devices/${id}/apns`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${relaySecret}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, environment: 'sandbox' }),
            });
            if (answer.status === 204) registered += 1;
          }
          return Response.json({ registered, token });
        }
        case '/push-unopenable': {
          // A push this phone holds no key for (as from a computer it was removed from):
          // R1's vector envelope, sealed under the all-zero test device's key.
          const vectors = JSON.parse(readFileSync(join(repo, 'packages/core/fixtures/inbox-relay-vectors.json'), 'utf8')) as { envelopes: { envelope: string }[] };
          const file = join(tmp, 'push-unopenable.json');
          writeFileSync(file, JSON.stringify({ aps: { alert: { title: 'Plannotator', body: 'New in your Inbox' }, 'mutable-content': 1, sound: 'default' }, e: vectors.envelopes[1]!.envelope }));
          run('xcrun', ['simctl', 'push', udid, 'ai.plannotator.app', file]);
          return Response.json({ ok: true });
        }
        case '/shot-one':
          // One frame as the screen is now (the lock screen cannot be re-themed mid-test).
          run('xcrun', ['simctl', 'io', udid, 'screenshot', join(shots, `${body.name ?? 'shot'}.png`)]);
          return Response.json({ ok: true });
        case '/appearance':
          run('xcrun', ['simctl', 'ui', udid, 'appearance', body.mode ?? 'light']);
          await sleep(1200);
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
try {
  const test = spawn(
    'xcodebuild',
    ['test', '-project', join(repo, 'apps/ios/Plannotator.xcodeproj'), '-scheme', 'Plannotator', '-destination', `id=${udid}`, '-derivedDataPath', derived, '-resultBundlePath', join(tmp, 'Proof.xcresult'), ...(only ? [`-only-testing:${only}`] : [])],
    { stdio: 'inherit', env: { ...process.env, TEST_RUNNER_PROOF_CONTROL: `http://127.0.0.1:${control.port}` } },
  );
  status = await new Promise<number>((r) => test.once('exit', (code) => r(code ?? 1)));
} finally {
  video?.kill('SIGINT');
  control.stop(true);
  proxy.stop(true);
  relay.kill();
  apple.close();
  if (status !== 0) writeFileSync(join(shots, 'relay-wrangler.log'), relayLog.join(''));
  await Promise.allSettled([claude, ...Object.values(others), ...newsAgents].map((a) => a.close()));
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
