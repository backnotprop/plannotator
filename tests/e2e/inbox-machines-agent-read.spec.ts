/**
 * An agent reads a thread on a linked machine (inbox-machines.md, "Agents read linked machines' threads"), proved
 * with two compiled Inboxes on loopback, linked through the real CLI pairing. No browser: the agents' own paths
 * (`plannotator inbox call`, which speaks to its computer's Inbox over `/mcp` and the control routes).
 *
 *  1. Studio's agent reads MacBook's thread by its id, and MacBook's agent reads Studio's: the same thread, the
 *     person's reply in it, the first line naming the computer it is on.
 *  2. A file of MacBook's thread: read_thread lists it with the command that saves it; Studio's agent runs that
 *     command and gets the same bytes on Studio, in a temp folder.
 *  3. Nothing of MacBook's thread is written to Studio's data folder by the reads.
 *  4. A reply into MacBook's thread from Studio's agent says it is not available from this computer yet.
 *  5. MacBook stopped: Studio's agent is told at once that it cannot be reached, with its name.
 *
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const CLOSED = 'http://127.0.0.1:9';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
}

let studio: Machine;
let macbook: Machine;
const agents: SimAgent[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-agent-read-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  return {
    name,
    root,
    dataDir,
    id: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: join(root, 'tmp'),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
/** One agent action from this computer's shell: its result, or its refusal's words. */
const call = (m: Machine, action: string, args: Record<string, unknown>) => {
  const run = cli(m, 'call', action, JSON.stringify(args));
  return { ...run, json: run.status === 0 ? (JSON.parse(run.out) as Record<string, any>) : null };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** A thread an agent on `m` started, with a file when given, and the person's reply in it (from `m`'s own window route). */
async function threadOn(m: Machine, subject: string, file?: { name: string; text: string }): Promise<{ id: string; reply: string }> {
  const agent = await SimAgent.connect({ binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const project = scratchProject(join(m.root, 'code'), 'billing-svc');
  if (file) writeFileSync(join(project, file.name), file.text);
  const sent = await agent.send({ project_path: project, subject, body: `${subject}: which limit do we ship?`, ...(file ? { attachments: [file.name] } : {}) });
  const id = sent.thread_id as string;
  const reply = `The lower one, for ${subject}.`;
  const health = await read<{ serverSession: string }>(m, '/api/inbox/health');
  const answer = await fetch(`${base(m)}/api/inbox/messages/${id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: reply, idempotency_key: `r-${id}`, serverSession: health.serverSession }) });
  expect(answer.status).toBe(200);
  return { id, reply };
}

/** Every file under a folder whose bytes name `needle`. */
function filesNaming(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return filesNaming(path, needle);
    return stat.size < 8 * 1024 * 1024 && readFileSync(path, 'utf8').includes(needle) ? [path] : [];
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  studio = machine('Studio');
  macbook = machine('MacBook');
  await start(studio);
  await start(macbook);
  link(studio, macbook);
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

let onMac = { id: '', reply: '' };

test('1. each computer\'s agent reads the other\'s thread by its id', async () => {
  onMac = await threadOn(macbook, 'Refund webhook');
  const onStudio = await threadOn(studio, 'Ledger export');
  // Studio's list of MacBook's threads names it before the read goes by the list (an id no list names is asked too).
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(onMac.id), { timeout: 15_000 }).toBe(true);
  for (const [reader, owner, thread] of [[studio, macbook, onMac], [macbook, studio, onStudio]] as const) {
    const got = call(reader, 'read_thread', { thread_id: thread.id });
    expect(got.status, got.err).toBe(0);
    expect(got.json!.machine).toEqual({ id: owner.id, name: owner.name });
    expect(got.json!.thread.thread_id).toBe(thread.id);
    expect(JSON.stringify(got.json!.thread.messages)).toContain(thread.reply);
  }
});

test('2. a file of the far thread is listed with its command, and that command saves the same bytes here', async () => {
  const withFile = await threadOn(macbook, 'Rate limits', { name: 'limits.md', text: '# Limits\n100 a minute\n' });
  const got = call(studio, 'read_thread', { thread_id: withFile.id });
  expect(got.status, got.err).toBe(0);
  const file = (got.json!.thread.messages as { files?: { name: string; fetch: string }[] }[]).flatMap((m) => m.files ?? []).find((f) => f.name === 'limits.md')!;
  expect(file.fetch.startsWith("plannotator inbox call fetch_file '")).toBe(true);
  const args = JSON.parse(file.fetch.slice(file.fetch.indexOf("'") + 1, -1)) as Record<string, unknown>;
  const saved = call(studio, 'fetch_file', args);
  expect(saved.status, saved.err).toBe(0);
  expect(String(saved.json!.path).startsWith(join(studio.root, 'tmp'))).toBe(true);
  expect(readFileSync(saved.json!.path, 'utf8')).toBe('# Limits\n100 a minute\n');
});

test('3. nothing of the far thread is written to the reading computer\'s data folder', () => {
  expect(filesNaming(studio.dataDir, onMac.reply)).toEqual([]);
});

test('4. a reply into the far thread says plainly it is not available from this computer yet', () => {
  const sent = call(studio, 'send_message', { reply_to: onMac.id, body: 'On it.' });
  expect(sent.status).toBe(1);
  expect(sent.err).toContain('thread_on_other_machine: ');
});

test('5. with the other computer stopped, the read says it cannot be reached, at once', async () => {
  await stopScratchInbox(macbook.dataDir);
  await expect.poll(async () => (await read<{ machines: { id: string; state: string }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === macbook.id)?.state, { timeout: 30_000 }).toBe('offline');
  const started = Date.now();
  const got = call(studio, 'read_thread', { thread_id: onMac.id });
  expect(got.status).toBe(1);
  expect(got.err).toContain('machine_offline: This thread is on MacBook, which cannot be reached now');
  expect(Date.now() - started).toBeLessThan(15_000);
});
