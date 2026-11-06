/**
 * System's setup on disk: the projects the dialog offers and the save of setup.json. No Inbox is started: the
 * route's two calls run against a temp data dir and temp project folders.
 * What regresses: a setup.json in another place or shape than the contract
 * (`<data dir>/system/<key>/setup.json`, `{ v: 1, repos, docs, agent, thread_message }`), a bad entry saved, the
 * drawing's thread lost on a second save, or a project offered that has no folder or no remote.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxProject, InboxProjectRepo } from '@plannotator/core/inbox-types';
import { InboxError } from '@plannotator/shared/inbox/schema';
import { saveSystemSetup, systemSetupProjects } from './inbox-system-setup';

let dir = '';
let dataDir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'system-setup-'));
  dataDir = join(dir, 'data');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function project(name: string, extra: Partial<InboxProject> = {}): InboxProject {
  const root = join(dir, 'code', name);
  mkdirSync(root, { recursive: true });
  return { id: `prj_${name}`, key: `${name}-abc123`, name, root, created_at: '2026-11-06T00:00:00.000Z', ...extra };
}

const remotes = new Map<string, InboxProjectRepo | null>();
const deps = () => ({ dataDir, repoOf: async (root: string) => remotes.get(root) ?? null });
const setupFile = (p: InboxProject) => join(dataDir, 'system', p.key, 'setup.json');

test('a save writes setup.json at the contract path, in the contract shape, private to the person', async () => {
  const app = project('app');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  const saved = await saveSystemSetup(app, { repos: ['acme/docs', 'acme/app'], docs: ['help.example.com'], agent: 'pi', model: null }, deps());
  const onDisk = JSON.parse(readFileSync(setupFile(app), 'utf8'));
  expect(onDisk).toEqual({ v: 1, repos: ['github.com/acme/docs'], docs: ['https://help.example.com/'], agent: 'pi', model: null, thread_message: null });
  expect(saved).toEqual(onDisk);
  expect(statSync(setupFile(app)).mode & 0o777).toBe(0o600);
  expect(statSync(join(dataDir, 'system', app.key)).mode & 0o777).toBe(0o700);
});

test('a second save keeps the drawing\'s thread and replaces the rest', async () => {
  const app = project('app');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  mkdirSync(join(dataDir, 'system', app.key), { recursive: true });
  writeFileSync(setupFile(app), JSON.stringify({ v: 1, repos: ['github.com/acme/old'], docs: [], agent: 'claude', model: null, thread_message: 'msg_01ABC' }));
  // No model named: the recommended one.
  await saveSystemSetup(app, { repos: [], docs: [], agent: 'opencode' }, deps());
  expect(JSON.parse(readFileSync(setupFile(app), 'utf8'))).toEqual({ v: 1, repos: [], docs: [], agent: 'opencode', model: 'claude-opus-5-5', thread_message: 'msg_01ABC' });
});

test('a bad entry is refused with its field, and nothing is written', async () => {
  const app = project('app');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  for (const body of [{ repos: ['not a repo'] }, { docs: ['ftp://example.com'] }, { agent: 'codex' }, { model: 'two words' }, { model: 5 }]) {
    const error = await saveSystemSetup(app, body, deps()).catch((e) => e);
    expect(error).toBeInstanceOf(InboxError);
    expect((error as InboxError).code).toBe('validation_error');
    expect((error as InboxError).details?.field).toBe(Object.keys(body)[0]);
  }
  expect(() => statSync(setupFile(app))).toThrow();
});

test('a project with no remote or no folder cannot be saved', async () => {
  const bare = project('bare');
  expect(((await saveSystemSetup(bare, {}, deps()).catch((e) => e)) as InboxError).details?.field).toBe('project_id');
  const gone = { ...project('gone'), root: join(dir, 'nowhere') };
  remotes.set(gone.root, { display: 'acme/gone', host: 'github.com' });
  expect(((await saveSystemSetup(gone, {}, deps()).catch((e) => e)) as InboxError).code).toBe('folder_missing');
});

test('the dialog is offered every project on this Mac with a remote, with what was saved before', async () => {
  const app = project('app', { display_name: 'The app' });
  const docs = project('docs');
  const bare = project('bare');
  const gone = { ...project('gone'), root: join(dir, 'nowhere') };
  const hostless = project('hostless');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  remotes.set(docs.root, { display: 'acme/docs', host: 'GitLab.com' });
  remotes.set(gone.root, { display: 'acme/gone', host: 'github.com' });
  remotes.set(hostless.root, { display: 'acme/hostless', host: null });
  await saveSystemSetup(app, { docs: ['help.example.com'] }, deps());
  const offered = await systemSetupProjects([app, docs, bare, gone, hostless], deps());
  expect(offered.map((p) => [p.id, p.name, p.repo])).toEqual([
    ['prj_app', 'The app', 'github.com/acme/app'],
    ['prj_docs', 'docs', 'gitlab.com/acme/docs'],
  ]);
  expect(offered[0]!.setup?.docs).toEqual(['https://help.example.com/']);
  expect(offered[1]!.setup).toBeNull();
});
