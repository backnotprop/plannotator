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
 * list the computer's devices, take a light and a dark screenshot, record
 * the screen.
 *
 *   bun apps/ios/scripts/proof.ts --binary .local/plannotator \
 *     [--device "iPhone 17"] [--shots .local/proof/ios] [--derived <DerivedData>] [--keep-simulator]
 *
 * Every process runs with PLANNOTATOR_BROWSER=none and its own data dir; the
 * person's ~/.plannotator is never read.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../../scripts/inbox-sim.ts';

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

const question = (prompt: string, choices: string[], extra: string[] = []) =>
  [':::question', prompt, ...extra, '', ...choices.map((c) => `- [ ] ${c}`), `Recommended: ${choices[0]}`, ':::'].join('\n');

let stoppedThread = '';
const newsAgents: SimAgent[] = [];
let reply: Promise<Record<string, unknown>> | null = null;

// As an agent waits: call again after each "waiting", and after a client
// timeout (a slow CI runner can hold a call past the SDK's 60 s default).
async function waitForPersonReply(threadId: string): Promise<Record<string, unknown>> {
  for (;;) {
    const result = await claude.waitForReply(threadId, 25).catch((error: unknown) => {
      if (String(error).includes('timed out')) return { status: 'waiting' };
      throw error;
    });
    if (result.status !== 'waiting') return result;
  }
}

async function seed(): Promise<Record<string, string>> {
  const stopped = await claude.send({ project_path: projects['billing-svc']!, body: DEMO_MESSAGES.stopped, subject: 'Which way should the worker go on a Stripe 409?' });
  stoppedThread = stopped.thread_id as string;
  reply = waitForPersonReply(stoppedThread);
  await others.pi.send({ project_path: projects['search-indexer']!, body: ['The archive has 41 projects with stale indexes.', '', question('Reindex the archived projects now?', ['Reindex tonight', 'Leave them'], ['Holds up: the search page; the export; the archive banner.'])].join('\n'), subject: 'Reindex the archived projects now?' });
  await others.claudeTests.send({ project_path: projects['billing-svc']!, body: ['The retry worker is ready.', '', question('Run the retry tests against the Stripe test clock?', ['Yes', 'No'], ['They take about four minutes against the test key.'])].join('\n'), subject: 'Run the retry tests against the Stripe test clock?' });
  await others.claudeRefunds.send({ project_path: projects['billing-svc']!, body: DEMO_MESSAGES.named, thread: 'refund-webhooks', subject: 'Refund events: trust the webhook or poll Stripe?' });
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
  return { stopped: stoppedThread };
}

async function more(): Promise<void> {
  // New sessions, so each message starts its own thread.
  const codex = await agent('Codex', 'codex');
  const opencode = await agent('OpenCode', 'opencode');
  newsAgents.push(codex, opencode);
  await codex.send({ project_path: projects['checkout-web']!, body: question('Ship the dark ticket page behind a flag?', ['Yes', 'No']), subject: 'Ship the dark ticket page behind a flag?' });
  await opencode.send({ project_path: projects['docs-site']!, body: question('Keep the old install page for a week?', ['Yes', 'No']), subject: 'Keep the old install page for a week?' });
}

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
          await more();
          return Response.json({ ok: true });
        case '/offer': {
          const answer = await windowRoute('/api/inbox/pairing', { method: 'POST', body: '{}' });
          const offer = (await answer.json()) as { offer: { code: string } };
          if (!answer.ok) throw new Error(`pairing offer: ${answer.status} ${JSON.stringify(offer)}`);
          return Response.json({ address: `127.0.0.1:${registry.port}`, code: offer.offer.code });
        }
        case '/reply': {
          // What the agent's wait_for_reply received for the stopped thread.
          const result = await Promise.race([reply, sleep(90_000).then(() => null)]);
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
    ['test', '-project', join(repo, 'apps/ios/Plannotator.xcodeproj'), '-scheme', 'Plannotator', '-destination', `id=${udid}`, '-derivedDataPath', derived, '-resultBundlePath', join(tmp, 'Proof.xcresult')],
    { stdio: 'inherit', env: { ...process.env, TEST_RUNNER_PROOF_CONTROL: `http://127.0.0.1:${control.port}` } },
  );
  status = await new Promise<number>((r) => test.once('exit', (code) => r(code ?? 1)));
} finally {
  video?.kill('SIGINT');
  control.stop(true);
  await Promise.allSettled([claude, ...Object.values(others), ...newsAgents].map((a) => a.close()));
  await fetch(`${inbox}/api/inbox/control/stop`, { method: 'POST', headers: { Authorization: `Bearer ${registry.token}` } }).catch(() => {});
  if (!keepSimulator) spawnSync('xcrun', ['simctl', 'delete', udid]);
  if (status === 0) rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`\nKept for a look: ${tmp} (Proof.xcresult, the Inbox's data dir)\n`);
}
process.stdout.write(`\nScreenshots and the recording: ${shots}\n`);
process.exit(status);
