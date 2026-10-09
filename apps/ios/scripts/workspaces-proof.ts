/**
 * The iPhone app's Workspaces source, proved in action against a real
 * Workspaces deployment (staging) and a real local Inbox.
 *
 * Starts a compiled `plannotator inbox --background` under a temp data dir (so
 * the switcher has both sources), makes a fresh simulator, and runs the
 * XCUITest `WorkspacesProofTests`, which signs in through the real AuthKit page
 * in the system browser sheet with a test account. The test asks this script,
 * over a loopback control server, for what only the agent and the computer can
 * do: an agent with a Workspaces API key asks a question in a comment that tags
 * the person (MCP `create_annotation`) and reads the reply (`list_annotations`);
 * the session cookie the app holds is read from the simulator's app container
 * so the proof can show that sign-out ended it at Workspaces (the next call is
 * 401). Light and dark screenshots and a recording land in `--shots`.
 *
 *   WORKSPACES_PROOF_EMAIL=... WORKSPACES_PROOF_PASSWORD=... WORKSPACES_PROOF_AGENT_KEY=... \
 *   bun apps/ios/scripts/workspaces-proof.ts --binary .local/plannotator \
 *     [--origin https://staging.workspaces.plannotator.ai] [--device "iPhone 17"] \
 *     [--shots .local/proof/ios-workspaces] [--derived <DerivedData>] [--keep-simulator]
 *
 * The account and the key are a test account's, never a person's own; none of
 * them is printed. The agent's workspace is made for the run and deleted after.
 * It runs locally: CI has no Workspaces credentials (the XCUITest skips itself
 * without this script).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SimAgent, scratchProject } from '../../../scripts/inbox-sim.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repo = resolve(dirname(new URL(import.meta.url).pathname), '../../..');
const binary = resolve(flag('--binary', '.local/plannotator')!);
const origin = flag('--origin', 'https://staging.workspaces.plannotator.ai')!;
const deviceType = flag('--device', 'iPhone 17')!;
const shots = resolve(flag('--shots', join(repo, '.local/proof/ios-workspaces'))!);
const derived = resolve(flag('--derived', join(tmpdir(), 'plannotator-ios-derived'))!);
const keepSimulator = args.includes('--keep-simulator');

const email = process.env.WORKSPACES_PROOF_EMAIL ?? '';
const password = process.env.WORKSPACES_PROOF_PASSWORD ?? '';
const agentKey = process.env.WORKSPACES_PROOF_AGENT_KEY ?? '';
if (!email || !password || !agentKey) {
  process.stderr.write('Set WORKSPACES_PROOF_EMAIL, WORKSPACES_PROOF_PASSWORD (a test account) and WORKSPACES_PROOF_AGENT_KEY (an API key of that account).\n');
  process.exit(2);
}
/** Never let a secret reach a log line. */
const scrub = (text: string) => [email, password, agentKey].reduce((t, s) => t.split(s).join('<redacted>'), text);

const tmp = mkdtempSync(join(tmpdir(), 'plannotator-ios-ws-proof-'));
mkdirSync(join(tmp, 'home'), { recursive: true });
mkdirSync(shots, { recursive: true });
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: join(tmp, 'home'),
  PLANNOTATOR_DATA_DIR: join(tmp, 'data'),
  PLANNOTATOR_BROWSER: 'none',  // Phones are hidden in releases until the iPhone app ships; the app's proofs turn them on.
  PLANNOTATOR_INBOX_PHONES: '1',
};
// The Inbox runs on a temp data dir, never the person's own (row 5109).
if (!env.PLANNOTATOR_DATA_DIR!.startsWith(tmpdir()) || env.PLANNOTATOR_DATA_DIR!.includes('.plannotator')) throw new Error('not a temp data dir');

function run(cmd: string, argv: string[], options: { env?: Record<string, string> } = {}): string {
  const result = spawnSync(cmd, argv, { env: options.env ?? (process.env as Record<string, string>), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${result.status}): ${scrub(result.stderr || result.stdout)}`);
  return result.stdout;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── The local Inbox: one question waiting, so the switcher counts both sources ───

run(binary, ['inbox', '--background'], { env });
const registry = JSON.parse(readFileSync(join(env.PLANNOTATOR_DATA_DIR!, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const inbox = `http://127.0.0.1:${registry.port}`;
const local = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
await local.send({
  project_path: scratchProject(join(tmp, 'src'), 'billing-svc'),
  subject: 'Which way should the worker go on a Stripe 409?',
  body: [':::question', 'Which way should the worker go on a Stripe 409?', '', '- [ ] Retry with the same idempotency key', '- [ ] Fail the job', 'Recommended: Retry with the same idempotency key', ':::'].join('\n'),
});

// ─── Workspaces: the agent's REST setup and its MCP session ───

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, {
    method,
    headers: { Authorization: `Bearer ${agentKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${scrub(text)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const me = await api<{ user_id: string; memberships: { org_id: string; name: string }[] }>('GET', '/v1/me');
const team = me.memberships[0];
if (!team) throw new Error('The test account needs a team, so the comment reaches it on the team channel.');
const { projects } = await api<{ projects: { id: string; name: string; org_id: string | null }[] }>('GET', '/v1/projects');
const project =
  projects.find((p) => p.name === 'billing-svc' && p.org_id === team.org_id) ??
  (await api<{ project: { id: string } }>('POST', '/v1/projects', { name: 'billing-svc', org_id: team.org_id })).project;
const created = await api<{ workspace: { id: string }; document: { id: string } }>('POST', '/v1/workspaces', {
  name: 'Retry worker plan',
  org_id: team.org_id,
  project_id: project.id,
  document: {
    path: 'plan.md',
    body: '# Retry worker plan\n\nThe worker retries a failed Stripe call at most three times, 2, 4 and 8 seconds apart, with the same idempotency key.\n\n## Rollout\n\nShip behind the `billing-retries` flag. Off for EU tenants until the audit lands.\n',
  },
});
const workspace = created.workspace.id;
const documentId = created.document.id;

const mcp = new Client({ name: 'm7-proof-agent', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentKey}` } } }));
async function tool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await mcp.callTool({ name: `workspaces.${name}`, arguments: input })) as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  if (result.isError) throw new Error(`${name}: ${scrub(JSON.stringify(result.content))}`);
  if (result.structuredContent) return result.structuredContent;
  const text = result.content.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

const question = (prompt: string, choices: string[], extra: string[] = []) =>
  [':::question', prompt, ...extra, '', ...choices.map((c) => `- [ ] ${c}`), '', `Recommended: ${choices[0]}`, ':::'].join('\n');

/** The agent asks in a comment that tags the person (create_annotation). */
async function ask(quote: string, body: string): Promise<string> {
  const comment = await tool('create_annotation', { workspace_id: workspace, target: { document_id: documentId }, anchor: { type: 'text', quote }, body, mentions: [me.user_id] });
  const id = (comment.id ?? (comment.annotation as { id?: string } | undefined)?.id) as string | undefined;
  if (!id) throw new Error(`create_annotation answered no id: ${scrub(JSON.stringify(comment)).slice(0, 400)}`);
  return id;
}

/** What the agent reads back (list_annotations, asked_by me). */
async function readAnswers(): Promise<Record<string, unknown>> {
  return tool('list_annotations', { workspace_id: workspace, target: { document_id: documentId }, asked_by: 'me' });
}

// ─── The simulator ───

const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '-j'])).runtimes as { identifier: string; platform: string; isAvailable: boolean; version: string }[];
const runtime = runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable).sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).at(-1);
if (!runtime) throw new Error('No iOS simulator runtime is installed.');
const udid = run('xcrun', ['simctl', 'create', `mobile-m7-${process.pid}`, deviceType, runtime.identifier]).trim();
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

/** The session cookie the app holds, from its own cookie store in the simulator
 * (written to disk a moment after the app leaves the front, so it is polled). */
/** Every cookie the app holds for the origin, by name (read once, after the app wrote them). */
async function appCookies(): Promise<Record<string, string>> {
  const container = run('xcrun', ['simctl', 'get_app_container', udid, 'ai.plannotator.app', 'data']).trim();
  const dir = join(container, 'Library/Cookies');
  const host = new URL(origin).hostname;
  const jar: Record<string, string> = {};
  for (let i = 0; i < 30 && !jar.session; i++) {
    for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.binarycookies')) : []) {
      for (const c of readBinaryCookies(readFileSync(join(dir, file)))) if (c.domain.replace(/^\./, '') === host) jar[c.name] = c.value;
    }
    if (!jar.session) await sleep(500);
  }
  return jar;
}

/** The app's pick key (WorkspacesSource.pickKey): the comment, question, revision and answer, hashed. */
function pickKey(message: string, key: string, revision: number, answer: Record<string, unknown>): string {
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(answer).sort(([a], [b]) => (a < b ? -1 : 1))));
  const digest = new Bun.CryptoHasher('sha256').update(`${message}|${key}|${revision}|${sorted}`).digest('hex');
  return `pick-${digest.slice(0, 32)}`;
}

async function appSessionCookie(want: 'present' | 'gone' = 'present'): Promise<string | null> {
  const container = run('xcrun', ['simctl', 'get_app_container', udid, 'ai.plannotator.app', 'data']).trim();
  const host = new URL(origin).hostname;
  let found: string | null = null;
  for (let i = 0; i < 30; i++) {
    const dir = join(container, 'Library/Cookies');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.binarycookies')) : [];
    found = null;
    for (const file of files) {
      found ??= readBinaryCookies(readFileSync(join(dir, file))).find((c) => c.name === 'session' && c.domain.replace(/^\./, '') === host)?.value ?? null;
    }
    if ((want === 'present') === (found !== null)) return found;
    await sleep(500);
  }
  return found;
}

/** Apple's binarycookies file: pages of records, each with offsets to NUL-terminated strings. */
function readBinaryCookies(data: Buffer): { domain: string; name: string; value: string }[] {
  if (data.toString('latin1', 0, 4) !== 'cook') return [];
  const pages = data.readUInt32BE(4);
  const sizes = Array.from({ length: pages }, (_, i) => data.readUInt32BE(8 + i * 4));
  const cookies: { domain: string; name: string; value: string }[] = [];
  let at = 8 + pages * 4;
  for (const size of sizes) {
    const page = data.subarray(at, at + size);
    const count = page.readUInt32LE(4);
    for (let i = 0; i < count; i++) {
      const start = page.readUInt32LE(8 + i * 4);
      const text = (offset: number) => {
        const from = start + page.readUInt32LE(start + offset);
        return page.toString('utf8', from, page.indexOf(0, from));
      };
      cookies.push({ domain: text(16), name: text(20), value: text(28) });
    }
    at += size;
  }
  return cookies;
}

// ─── The control server the test calls ───

let sessionCookie: string | null = null;
const control = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 120,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === 'POST' ? ((await request.json().catch(() => ({}))) as Record<string, string>) : {};
    try {
      switch (path) {
        case '/email':
          // The test account's address, for the test to type into the AuthKit page.
          return Response.json({ email });
        case '/password-to-pasteboard':
          // The password reaches the page by Paste from the simulator's pasteboard:
          // typed text is written into the test's log, a paste is not.
          spawnSync('xcrun', ['simctl', 'pbcopy', udid], { input: password });
          return Response.json({ ok: true });
        case '/clear-pasteboard':
          spawnSync('xcrun', ['simctl', 'pbcopy', udid], { input: '' });
          return Response.json({ ok: true });
        case '/offer': {
          const answer = await fetch(`${inbox}/api/inbox/pairing`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const offer = (await answer.json()) as { offer: { code: string } };
          if (!answer.ok) throw new Error(`pairing offer: ${answer.status}`);
          return Response.json({ address: `127.0.0.1:${registry.port}`, code: offer.offer.code });
        }
        case '/ask': {
          // Two questions on the plan, the first one Stopped, tagging the person.
          const id = await ask(
            'at most three times, 2, 4 and 8 seconds apart',
            [
              'The retry worker is ready. Two things before I ship it.',
              '',
              question('Run the retry tests against the Stripe test clock?', ['Yes', 'No - skip them this once'], ['They take about four minutes against the test key.', '', 'Stopped: I cannot merge the worker without a green run.']),
              '',
              question('Ship the retry worker behind a flag?', ['Yes', 'No'], ['', 'Holds up: EU rollout; billing dashboard']),
            ].join('\n'),
          );
          return Response.json({ thread: `${workspace}/${documentId}/${id}` });
        }
        case '/ask-more': {
          const id = await ask('Off for EU tenants until the audit lands.', ['The audit notes say the EU flag can go on in November.', '', question('Schedule the EU flag for 3 November?', ['Yes', 'No'])].join('\n'));
          return Response.json({ thread: `${workspace}/${documentId}/${id}` });
        }
        case '/answers': {
          // The agent reads its comments back (list_annotations, asked_by me).
          const answers = await readAnswers();
          const list = ((answers.annotations ?? answers.items ?? []) as Record<string, unknown>[]).find((a) => a.id === body.annotation);
          if (!list) return Response.json({ error: 'not listed', keys: Object.keys(answers) }, { status: 404 });
          const replies = (list.replies ?? []) as { body: string }[];
          const questions = (list.questions ?? []) as { key: string; state: string; answer: unknown; decision_id: string | null }[];
          return Response.json({ reply: replies.at(-1)?.body ?? null, questions });
        }
        case '/decisions': {
          const decisions = await api<{ decisions: { id: string; text: string; origin_workspace_id: string }[] }>('GET', `/v1/projects/${project.id}/decisions`);
          return Response.json({ decisions: decisions.decisions.filter((d) => d.origin_workspace_id === workspace) });
        }
        case '/hold-session':
          // Keep the session cookie the app holds now, to try it after sign-out.
          sessionCookie = await appSessionCookie();
          return Response.json({ held: sessionCookie !== null });
        case '/replay-pick': {
          // The phone's pick sent again as its retry would be, with the app's own
          // session and the key the app derives: W2 answers the first result
          // (a replay). The same pick under another key is a conflict.
          const jar = await appCookies();
          const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
          const [ws, doc, annotation] = (body.thread ?? '').split('/');
          const revision = Number(body.revision);
          const answer = { v: 1, key: body.key, kind: 'single', prompt: body.prompt, selected: [body.choice] };
          const send = async (key: string) => {
            const response = await fetch(`${origin}/v1/workspaces/${ws}/documents/${doc}/answers`, {
              method: 'POST',
              headers: { Cookie: cookie, 'X-CSRF-Token': jar.csrf ?? '', 'Content-Type': 'application/json', 'Idempotency-Key': key },
              body: JSON.stringify({ annotation_id: annotation, questions: [{ key: body.key, revision, answer }] }),
            });
            const json = (await response.json().catch(() => ({}))) as { questions?: { key: string; revision: number; state: string }[]; error?: { code: string } };
            return { status: response.status, revision: json.questions?.find((q) => q.key === body.key)?.revision ?? null, code: json.error?.code ?? null };
          };
          const replay = await send(pickKey(body.thread!, body.key!, revision, answer));
          const other = await send(`pick-${crypto.randomUUID().replaceAll('-', '')}`);
          return Response.json({ replay, other });
        }
        case '/app-session-gone':
          // After sign-out the app's own store holds no session cookie.
          return Response.json({ gone: (await appSessionCookie('gone')) === null });
        case '/held-session': {
          // The held cookie, tried once more: 401 means sign-out ended it at Workspaces.
          if (!sessionCookie) return Response.json({ error: 'no cookie held' }, { status: 500 });
          const answer = await fetch(`${origin}/v1/me`, { headers: { Cookie: `session=${sessionCookie}` } });
          return Response.json({ status: answer.status });
        }
        case '/open-url':
          run('xcrun', ['simctl', 'openurl', udid, body.url ?? '']);
          return Response.json({ ok: true });
        case '/text-size':
          run('xcrun', ['simctl', 'ui', udid, 'content_size', body.size ?? 'large']);
          await sleep(1500);
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
      return Response.json({ error: scrub(String(error)) }, { status: 500 });
    }
  },
});

// ─── The test ───

let status = 1;
try {
  const test = spawn(
    'xcodebuild',
    [
      'test', '-project', join(repo, 'apps/ios/Plannotator.xcodeproj'), '-scheme', 'Plannotator', '-destination', `id=${udid}`,
      '-derivedDataPath', derived, '-resultBundlePath', join(tmp, 'Proof.xcresult'), '-only-testing:PlannotatorUITests/WorkspacesProofTests',
      `WORKSPACES_HOST=${new URL(origin).hostname}`,
    ],
    { stdio: 'inherit', env: { ...process.env, TEST_RUNNER_WORKSPACES_PROOF_CONTROL: `http://127.0.0.1:${control.port}` } },
  );
  status = await new Promise<number>((r) => test.once('exit', (code) => r(code ?? 1)));
} finally {
  video?.kill('SIGINT');
  control.stop(true);
  await mcp.close().catch(() => {});
  await api('DELETE', `/v1/workspaces/${workspace}`).catch((error) => process.stderr.write(`Could not delete the proof's workspace ${workspace}: ${error}\n`));
  await local.close().catch(() => {});
  await fetch(`${inbox}/api/inbox/control/stop`, { method: 'POST', headers: { Authorization: `Bearer ${registry.token}` } }).catch(() => {});
  if (!keepSimulator) spawnSync('xcrun', ['simctl', 'delete', udid]);
  if (status === 0) rmSync(tmp, { recursive: true, force: true });
  else process.stdout.write(`\nKept for a look: ${tmp} (Proof.xcresult)\n`);
}
process.stdout.write(`\nScreenshots and the recording: ${shots}\n`);
process.exit(status);
