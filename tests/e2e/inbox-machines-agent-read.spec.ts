/**
 * An agent reads a thread on a linked machine (inbox-machines.md, "Agents read linked machines' threads"), proved
 * with two compiled Inboxes on loopback, linked through the real CLI pairing. No browser: the agents' own paths
 * (`plannotator inbox call`, which speaks to its computer's Inbox over `/mcp` and the control routes).
 *
 *  1. Studio's agent reads MacBook's thread by its id, and MacBook's agent reads Studio's: the same thread, the
 *     person's reply in it, the first line naming the computer it is on.
 *  2. A file of MacBook's thread: read_thread lists it with the command that saves it; Studio's agent runs that
 *     command and gets the same bytes on Studio, in a temp folder.
 *  2b. The command saves the file itself: in the folder it was given (relative to its working folder), or in its own
 *     temp folder, never the Inbox's.
 *  3. Nothing of MacBook's thread is written to Studio's data folder by the reads.
 *  3b. A read from Studio leaves MacBook's delivery state unchanged: the person's reply still waits for MacBook's
 *     agent, and that agent's own read takes it.
 *  4. A reply into MacBook's thread from Studio's agent says it is not available from this computer yet.
 *  4b. Studio's agent finds MacBook's thread with search and with read_thread's list, in its own project (the same
 *      folder name there), each far row marked with MacBook; then read by its id.
 *  4c. "This project" by git remote: a project in another folder on MacBook with the same origin is found from
 *      Studio's, on the first ask with both repo caches cold; one with the same folder name and another origin is not.
 *  5. MacBook stopped: Studio's agent is told at once that it cannot be reached, with its name; search and the list
 *     answer with Studio's own rows and one line naming MacBook.
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

/** The CLI on `m`: its environment (with `shell` over it, an agent shell's own), in `cwd` (default its root). */
const cliIn = (m: Machine, shell: { env?: Record<string, string>; cwd?: string }, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: { ...m.env, ...shell.env }, cwd: shell.cwd ?? m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const cli = (m: Machine, ...args: string[]) => cliIn(m, {}, ...args);
/** One agent action from this computer's shell: its result, or its refusal's words. */
const call = (m: Machine, action: string, args: Record<string, unknown>, shell: { env?: Record<string, string>; cwd?: string } = {}) => {
  const run = cliIn(m, shell, 'call', action, JSON.stringify(args));
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
async function threadOn(m: Machine, subject: string, file?: { name: string; text: string }): Promise<{ id: string; reply: string; agent: SimAgent }> {
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
  return { id, reply, agent };
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
let fileArgs: Record<string, unknown> = {};

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
  fileArgs = args;
  const saved = call(studio, 'fetch_file', args);
  expect(saved.status, saved.err).toBe(0);
  expect(String(saved.json!.path).startsWith(join(studio.root, 'tmp'))).toBe(true);
  expect(readFileSync(saved.json!.path, 'utf8')).toBe('# Limits\n100 a minute\n');
});

test('2b. the fetched file is saved by the CLI, in the folder the CLI was given', () => {
  // The agent's shell has its own temp folder and working folder; the Inbox's is studio.root/tmp.
  const shellTmp = join(studio.root, 'agent-tmp');
  const work = join(studio.root, 'agent-work');
  mkdirSync(shellTmp, { recursive: true });
  mkdirSync(work, { recursive: true });
  const shell = { env: { TMPDIR: shellTmp }, cwd: work };
  const inFolder = call(studio, 'fetch_file', { ...fileArgs, folder: 'fetched' }, shell);
  expect(inFolder.status, inFolder.err).toBe(0);
  expect(inFolder.json!.path).toBe(join(work, 'fetched', 'limits.md'));
  expect(readFileSync(inFolder.json!.path, 'utf8')).toBe('# Limits\n100 a minute\n');
  // No folder: a new one in the command's own temp folder, not the Inbox's.
  const inTemp = call(studio, 'fetch_file', fileArgs, shell);
  expect(inTemp.status, inTemp.err).toBe(0);
  expect(String(inTemp.json!.path).startsWith(join(shellTmp, 'plannotator-file-'))).toBe(true);
  expect(readFileSync(inTemp.json!.path, 'utf8')).toBe('# Limits\n100 a minute\n');
});

test('3. nothing of the far thread is written to the reading computer\'s data folder', () => {
  expect(filesNaming(studio.dataDir, onMac.reply)).toEqual([]);
});

test('3b. a read from A leaves B\'s delivery state unchanged', async () => {
  const waiting = await threadOn(macbook, 'Retry budget');
  const row = async () => {
    const list = await read<{ sections: { threads: { thread_id: string; sent: unknown; unread: boolean }[] }[] }>(macbook, '/api/inbox/threads');
    const found = list.sections.flatMap((s) => s.threads).find((t) => t.thread_id === waiting.id)!;
    return { sent: found.sent, unread: found.unread };
  };
  const before = await row();
  expect(before.sent).toMatchObject({ checked_at: null });
  for (const ask of [{ thread_id: waiting.id }, { thread_id: waiting.id, format: 'full' }]) {
    const got = call(studio, 'read_thread', ask);
    expect(got.status, got.err).toBe(0);
  }
  expect(await row()).toEqual(before);
  // MacBook's own agent still gets the person's reply.
  const reply = await waiting.agent.nextReply(waiting.id, 20);
  expect(reply.body).toContain(waiting.reply);
});

test('4. a reply into the far thread says plainly it is not available from this computer yet', () => {
  const sent = call(studio, 'send_message', { reply_to: onMac.id, body: 'On it.' });
  expect(sent.status).toBe(1);
  expect(sent.err).toContain('thread_on_other_machine: ');
});

/** A git project with `origin` set, as a clone on that computer would have it. */
function cloneOf(m: Machine, folder: string, origin: string): string {
  const dir = scratchProject(join(m.root, 'code'), folder);
  spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return dir;
}

test('4b. Studio\'s agent finds MacBook\'s thread with search and the list, in its own project', () => {
  const here = join(studio.root, 'code', 'billing-svc');
  const found = call(studio, 'search', { query: 'Refund webhook' }, { cwd: here });
  expect(found.status, found.err).toBe(0);
  expect(found.json!.results).toContainEqual(expect.objectContaining({ thread_id: onMac.id, machine: { id: macbook.id, name: 'MacBook' } }));
  const listed = call(studio, 'read_thread', { asked_by: 'anyone' }, { cwd: here });
  expect(listed.status, listed.err).toBe(0);
  expect(listed.json!.threads).toContainEqual(expect.objectContaining({ thread_id: onMac.id, machine: { id: macbook.id, name: 'MacBook' } }));
  // Studio's own thread is still listed, unmarked.
  expect((listed.json!.threads as { machine?: unknown }[]).some((t) => !t.machine)).toBe(true);
  const got = call(studio, 'read_thread', { thread_id: onMac.id });
  expect(got.status, got.err).toBe(0);
  expect(got.json!.machine).toEqual({ id: macbook.id, name: 'MacBook' });
});

test('4c. this project on the other computer is the one with the same git remote', async () => {
  const mine = cloneOf(studio, 'ledger', 'git@github.com:acme/ledger.git');
  const same = cloneOf(macbook, 'ledger-main', 'https://github.com/acme/ledger.git');
  const other = cloneOf(macbook, 'ledger', 'https://github.com/someone-else/ledger.git');
  const agent = await SimAgent.connect({ binary, env: macbook.env, name: 'Claude Code', host: 'claude-code', cwd: macbook.root });
  agents.push(agent);
  const sameId = (await agent.send({ project_path: same, subject: 'Ledger migration', body: 'Migration of the ledger tables.' })).thread_id as string;
  const otherId = (await agent.send({ project_path: other, subject: 'Other ledger migration', body: 'Migration of another ledger.' })).thread_id as string;
  // Studio's project needs no thread of its own: its folder's remote names it. The first answer counts: both repo
  // caches are cold for these new folders, and an early answer must never take the other repository by its name.
  const found = call(studio, 'search', { query: 'migration' }, { cwd: mine });
  expect(found.status, found.err).toBe(0);
  expect((found.json!.results as { thread_id: string }[]).map((r) => r.thread_id)).toEqual([sameId]);
  const listed = call(studio, 'read_thread', { asked_by: 'anyone' }, { cwd: mine });
  expect(listed.status, listed.err).toBe(0);
  expect((listed.json!.threads as { thread_id: string; machine?: unknown }[]).filter((t) => t.machine).map((t) => t.thread_id)).toEqual([sameId]);
  const every = call(studio, 'search', { query: 'migration', all_projects: true }, { cwd: mine });
  expect((every.json!.results as { thread_id: string }[]).map((r) => r.thread_id).sort()).toEqual([sameId, otherId].sort());
});

test('5. with the other computer stopped, the read says it cannot be reached, at once', async () => {
  await stopScratchInbox(macbook.dataDir);
  await expect.poll(async () => (await read<{ machines: { id: string; state: string }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === macbook.id)?.state, { timeout: 30_000 }).toBe('offline');
  const started = Date.now();
  const got = call(studio, 'read_thread', { thread_id: onMac.id });
  expect(got.status).toBe(1);
  expect(got.err).toContain('machine_offline: This thread is on MacBook, which cannot be reached now');
  expect(Date.now() - started).toBeLessThan(15_000);
  const here = join(studio.root, 'code', 'billing-svc');
  const found = call(studio, 'search', { query: 'Ledger export' }, { cwd: here });
  expect(found.status, found.err).toBe(0);
  expect((found.json!.results as { machine?: unknown }[]).every((r) => !r.machine)).toBe(true);
  expect(found.json!.not_searched).toEqual(['Not searched: MacBook, which cannot be reached now (asleep, offline or still connecting).']);
  const listed = call(studio, 'read_thread', { asked_by: 'anyone' }, { cwd: here });
  expect(listed.json!.not_listed).toEqual(['Not listed: MacBook, which cannot be reached now (asleep, offline or still connecting).']);
  expect(Date.now() - started).toBeLessThan(30_000);
});
