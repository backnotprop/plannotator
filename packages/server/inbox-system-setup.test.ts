/**
 * System's setup on disk: the projects the dialog offers and the save of setup.json. No Inbox is started: the
 * route's two calls run against a temp data dir and temp project folders.
 * What regresses: a setup.json in another place or shape than the contract
 * (`<data dir>/system/<key>/setup.json`, `{ v: 1, repos, docs, agent, thread_message }`), a bad entry saved, the
 * drawing's thread lost on a second save, or a project offered that has no folder or no remote.
 * The route (`systemSetupRoute`, as inbox.ts calls it): anything read or written while System or Code review is
 * off, for a tailnet guest, for another site's page, on another method, or for a project the Inbox does not have.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxProject, InboxProjectRepo } from '@plannotator/core/inbox-types';
import { InboxError } from '@plannotator/shared/inbox/schema';
import { saveSystemSetup, systemSetupProjects, systemSetupRoute } from './inbox-system-setup';

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
  // No model named: the recommended one, in OpenCode's provider/model form.
  await saveSystemSetup(app, { repos: [], docs: [], agent: 'opencode' }, deps());
  expect(JSON.parse(readFileSync(setupFile(app), 'utf8'))).toEqual({ v: 1, repos: [], docs: [], agent: 'opencode', model: 'anthropic/claude-opus-5-5', thread_message: 'msg_01ABC' });
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
  // The drawing folder is Plannotator's, under the data dir, never a folder in the repo.
  expect(offered.map((p) => p.drawing)).toEqual([join(dataDir, 'system', app.key, 'drawing'), join(dataDir, 'system', docs.key, 'drawing')]);
  expect(offered[0]!.setup?.docs).toEqual(['https://help.example.com/']);
  expect(offered[1]!.setup).toBeNull();
});

describe('/api/inbox/system/setup', () => {
  const OWNER = 'owner@example.com';
  const HOST = '127.0.0.1:4000';
  const URL_ = `http://${HOST}/api/inbox/system/setup`;

  function route(switches: { codeReview: boolean; system: boolean }) {
    const app = project('app');
    remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
    const repoReads: string[] = [];
    const projects = [app];
    const store = {
      listProjects: () => projects,
      project: (id: string) => projects.find((p) => p.id === id) ?? null,
      canonicalProjectId: (id: string) => id,
    };
    const call = async (method: string, options: { body?: unknown; headers?: Record<string, string>; via?: 'local' | 'tailnet' } = {}) => {
      const via = options.via ?? 'local';
      const req = new Request(URL_, {
        method,
        headers: { host: HOST, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const response = await systemSetupRoute(req, {
        dataDir,
        repoOf: async (root) => {
          repoReads.push(root);
          return remotes.get(root) ?? null;
        },
        store,
        serverSession: 'srv',
        // As inbox.ts's ownerOrLocal: this computer, or the owner's login over the tailnet.
        ownerOrLocal: (r) => via === 'local' || r.headers.get('tailscale-user-login') === OWNER,
        // As inbox.ts's systemOn: System counts only while Code review is on.
        systemOn: () => switches.codeReview && switches.system,
        readBody: async (r) => (await r.json()) as Record<string, unknown>,
        json: (body, status = 200) => Response.json(body, { status }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const save = { serverSession: 'srv', project_id: app.id, repos: ['acme/docs'], docs: [], agent: 'claude', model: null };
    return { app, call, save, repoReads };
  }

  for (const switches of [{ codeReview: true, system: false }, { codeReview: false, system: true }]) {
    test(`off (${switches.codeReview ? 'System' : 'Code review'} off): GET and POST answer system_off, and nothing is read or written`, async () => {
      const { app, call, save, repoReads } = route(switches);
      expect(await call('GET')).toMatchObject({ status: 409, body: { code: 'system_off' } });
      expect(await call('POST', { body: save })).toMatchObject({ status: 409, body: { code: 'system_off' } });
      expect(repoReads).toEqual([]);
      expect(existsSync(setupFile(app))).toBe(false);
      expect(existsSync(join(dataDir, 'system'))).toBe(false);
    });
  }

  test('a tailnet guest, another site\'s page and another method are refused, and nothing is written', async () => {
    const { app, call, save, repoReads } = route({ codeReview: true, system: true });
    const guest = { via: 'tailnet' as const, headers: { 'tailscale-user-login': 'guest@example.com' } };
    expect(await call('GET', guest)).toMatchObject({ status: 403, body: { code: 'local_only' } });
    expect(await call('POST', { ...guest, body: save })).toMatchObject({ status: 403, body: { code: 'local_only' } });
    expect(await call('POST', { body: save, headers: { origin: 'https://evil.example' } })).toMatchObject({ status: 403, body: { code: 'cross_origin' } });
    expect(await call('POST', { body: save, headers: { 'sec-fetch-site': 'cross-site' } })).toMatchObject({ status: 403, body: { code: 'cross_origin' } });
    expect((await call('PUT', { body: save })).status).toBe(405);
    expect((await call('DELETE')).status).toBe(405);
    expect(repoReads).toEqual([]);
    expect(existsSync(setupFile(app))).toBe(false);
    // The owner over the tailnet, and the window's own page, are answered.
    expect((await call('GET', { via: 'tailnet', headers: { 'tailscale-user-login': OWNER } })).status).toBe(200);
    expect(await call('POST', { body: save, headers: { origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' } })).toMatchObject({ status: 200, body: { setup: { repos: ['github.com/acme/docs'] } } });
    expect(existsSync(setupFile(app))).toBe(true);
  });

  test('a save for a project the Inbox does not have is refused on project_id, and nothing is written', async () => {
    const { app, call, save } = route({ codeReview: true, system: true });
    for (const project_id of ['prj_nowhere', 5, undefined]) {
      const error = await call('POST', { body: { ...save, project_id } }).catch((e) => e);
      expect(error).toBeInstanceOf(InboxError);
      expect((error as InboxError).details?.field).toBe('project_id');
    }
    expect(existsSync(join(dataDir, 'system'))).toBe(false);
    // Another window's server session: refused before the save.
    expect((await call('POST', { body: { ...save, serverSession: 'old' } })).status).toBe(409);
    expect(existsSync(setupFile(app))).toBe(false);
  });
});
