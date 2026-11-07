/**
 * System's reads for the window (inbox-system.ts): no Inbox is started; the route's calls run against a temp data
 * dir with a small drawing written in it, temp project folders, and PRs and patches handed in.
 * What regresses: a project listed that can't be set up and has no drawing (or one dropped that has a drawing), a
 * drawing read from anywhere but `<data dir>/system/<key>/drawing/`, an open PR row for a PR that touches no drawn
 * part (or of another repo, or closed), a PR whose patch fails taking the others down, and anything read while
 * System or Code review is off, for a tailnet guest, for another site's page, or for a project the Inbox lacks.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { InboxProject, InboxProjectRepo, InboxPull } from '@plannotator/core/inbox-types';
import { InboxError } from '@plannotator/shared/inbox/schema';
import { systemDrawing, systemProjects, systemPullTouches, systemReadRoute } from './inbox-system';

let dir = '';
let dataDir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'system-reads-'));
  dataDir = join(dir, 'data');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A drawing that loads clean: the app (src/main.ts) holds the API (src/api/). */
const DRAWING: Record<string, string> = {
  'system.yaml': [
    'format: 1',
    'system: Small',
    'root: C-001',
    'scopes: { root: Small, app: The app }',
    'parts:',
    '  person: { name: Maya Chen, kind: people }',
    '  app: { name: The app, child: app, code: { src/main.ts: the entry } }',
    '  api: { in: app, name: API, code: { src/api: every route } }',
    '',
  ].join('\n'),
  'sheets/C-001.yaml': 'sheet: C-001\nscope: root\nkind: conceptual\ntitle: Small\nbands:\n  - { id: all, row: [person, app] }\n',
  'sheets/L-101.yaml': 'sheet: L-101\nscope: app\nkind: logical\ntitle: The app\nbands:\n  - { id: inside, row: [api] }\n',
};

function drawIn(key: string, files: Record<string, string> = DRAWING) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dataDir, 'system', key, 'drawing', rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function project(name: string, extra: Partial<InboxProject> = {}): InboxProject {
  const root = join(dir, 'code', name);
  mkdirSync(root, { recursive: true });
  return { id: `prj_${name}`, key: `${name}-abc123`, name, root, created_at: '2026-11-06T00:00:00.000Z', ...extra };
}

const remotes = new Map<string, InboxProjectRepo | null>();
const deps = () => ({ dataDir, repoOf: async (root: string) => remotes.get(root) ?? null });

const patch = (...paths: string[]) => paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`).join('');

function pull(number: number, extra: Partial<InboxPull> = {}): InboxPull {
  return {
    key: `github.com/acme/app#${number}`, platform: 'github', host: 'github.com', repo: 'acme/app', number, url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`, author: 'dana', mine: false, requested: true, state: 'open', base: 'main', head: `b${number}`, head_repo: 'acme/app',
    additions: 1, deletions: 1, files: 1, review: null, approved_by: null, reviewers: [], checks: null, updated_at: `2026-11-06T00:00:${String(number % 60).padStart(2, '0')}.000Z`, merged_at: null,
    ...extra,
  };
}

test('the projects: one that can be set up here, one with a drawing; never one with neither', async () => {
  const app = project('app');
  const gone = project('gone', { root: join(dir, 'nowhere', 'gone') });
  const plain = project('plain');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  drawIn(gone.key);
  const rows = await systemProjects([app, gone, plain], deps());
  expect(rows).toEqual([
    { id: app.id, key: app.key, name: 'app', repo: 'github.com/acme/app', state: 'none', sheets: 0, wanted: 0 },
    { id: gone.id, key: gone.key, name: 'gone', repo: null, state: 'drawn', sheets: 2, wanted: 0 },
  ]);
});

test('a drawing is read from the data folder; one that does not load is "broken" with no model', async () => {
  const app = project('app');
  remotes.set(app.root, { display: 'acme/app', host: 'github.com' });
  // A drawing in the person's checkout is never read.
  mkdirSync(join(app.root, '.plannotator', 'system'), { recursive: true });
  writeFileSync(join(app.root, '.plannotator', 'system', 'system.yaml'), DRAWING['system.yaml']!);
  expect((await systemDrawing(app, deps())).model).toBeNull();
  drawIn(app.key);
  const drawn = await systemDrawing(app, deps());
  expect(drawn.project.state).toBe('drawn');
  expect(Object.keys(drawn.model!.sheets).sort()).toEqual(['C-001', 'L-101']);
  drawIn(app.key, { 'system.yaml': 'format: 2\n' });
  const broken = await systemDrawing(app, deps());
  expect(broken.project.state).toBe('broken');
  expect(broken.model).toBeNull();
});

describe('the open PRs that change the drawing', () => {
  const model = async () => {
    const app = project('app');
    drawIn(app.key);
    return (await systemDrawing(app, deps())).model!;
  };

  test('only open PRs of the repo whose files a drawn part cites, with those parts', async () => {
    const patches: Record<string, string> = {
      'github.com/acme/app#1': patch('src/api/routes.ts'),
      'github.com/acme/app#2': patch('README.md', 'scripts/release.sh'),
      'github.com/acme/app#3': patch('src/main.ts', 'src/api/index.ts'),
      'github.com/acme/app#4': patch('src/main.ts'),
      'github.com/acme/other#5': patch('src/main.ts'),
    };
    const pulls = [pull(1), pull(2), pull(3, { state: 'draft' }), pull(4, { state: 'merged' }), pull(5, { key: 'github.com/acme/other#5', repo: 'acme/other' })];
    const asked: string[] = [];
    const answer = await systemPullTouches(await model(), 'github.com/ACME/app', pulls, async (key) => {
      asked.push(key);
      return patches[key]!;
    });
    expect(answer.unread).toBe(0);
    expect(answer.pulls).toEqual([
      { key: 'github.com/acme/app#3', parts: [{ id: 'app', name: 'The app' }, { id: 'api', name: 'API' }] },
      { key: 'github.com/acme/app#1', parts: [{ id: 'api', name: 'API' }] },
    ]);
    // The merged PR and the other repo's are never read.
    expect(asked.sort()).toEqual(['github.com/acme/app#1', 'github.com/acme/app#2', 'github.com/acme/app#3']);
  });

  test('a PR whose patch can\'t be read is counted, and the others still show', async () => {
    const answer = await systemPullTouches(await model(), 'github.com/acme/app', [pull(1), pull(2)], async (key) => {
      if (key.endsWith('#2')) throw new Error('too large');
      return patch('src/api/x.ts');
    });
    expect(answer).toEqual({ pulls: [{ key: 'github.com/acme/app#1', parts: [{ id: 'api', name: 'API' }] }], unread: 1 });
  });
});

describe('the routes', () => {
  const HOST = '127.0.0.1:4000';
  let switches = { system: true };
  let listed = 0;
  const app = () => project('app');
  const routeDeps = (projects: InboxProject[]) => ({
    ...deps(),
    store: {
      listProjects: () => projects,
      project: (id: string) => projects.find((p) => p.id === id) ?? null,
      canonicalProjectId: (id: string) => id,
    },
    serverSession: 'srv',
    ownerOrLocal: (req: Request) => req.headers.get('x-guest') !== '1',
    systemOn: () => switches.system,
    listPulls: async () => {
      listed += 1;
      return [pull(1)];
    },
    patchOf: async () => patch('src/api/a.ts'),
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  });
  const call = async (path: string, projects: InboxProject[], init: RequestInit & { query?: string } = {}) => {
    const req = new Request(`http://${HOST}${path}${init.query ?? ''}`, { method: init.method ?? 'GET', headers: { host: HOST, ...(init.headers as Record<string, string>) } });
    try {
      const res = await systemReadRoute(req, path, routeDeps(projects));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch (cause) {
      if (cause instanceof InboxError) return { status: 422, body: { code: cause.code } };
      throw cause;
    }
  };
  beforeEach(() => {
    switches = { system: true };
    listed = 0;
  });

  test('on: the projects, the drawing and its PRs', async () => {
    const a = app();
    remotes.set(a.root, { display: 'acme/app', host: 'github.com' });
    drawIn(a.key);
    expect((await call('/api/inbox/system/projects', [a])).body).toMatchObject({ projects: [{ id: a.id, state: 'drawn', sheets: 2 }] });
    const drawing = await call('/api/inbox/system/drawing', [a], { query: `?project=${a.id}` });
    expect(drawing.status).toBe(200);
    expect((drawing.body.model as { root: string }).root).toBe('C-001');
    expect((await call('/api/inbox/system/pulls', [a], { query: `?project=${a.id}` })).body).toMatchObject({ pulls: [{ key: 'github.com/acme/app#1', parts: [{ id: 'api' }] }], unread: 0 });
  });

  test('no drawing, or no repo: no PRs, and the pulls list is not read', async () => {
    const a = app();
    remotes.set(a.root, { display: 'acme/app', host: 'github.com' });
    expect((await call('/api/inbox/system/pulls', [a], { query: `?project=${a.id}` })).body).toMatchObject({ pulls: [], unread: 0 });
    remotes.set(a.root, null);
    drawIn(a.key);
    expect((await call('/api/inbox/system/pulls', [a], { query: `?project=${a.id}` })).body).toMatchObject({ pulls: [], unread: 0 });
    expect(listed).toBe(0);
  });

  test('refused: System off, another method, a tailnet guest, another site, a project the Inbox lacks', async () => {
    const a = app();
    remotes.set(a.root, { display: 'acme/app', host: 'github.com' });
    drawIn(a.key);
    switches.system = false;
    for (const path of ['/api/inbox/system/projects', '/api/inbox/system/drawing', '/api/inbox/system/pulls']) {
      expect(await call(path, [a], { query: `?project=${a.id}` })).toMatchObject({ status: 409, body: { code: 'system_off' } });
    }
    switches.system = true;
    expect((await call('/api/inbox/system/projects', [a], { method: 'POST' })).status).toBe(405);
    expect(await call('/api/inbox/system/projects', [a], { headers: { 'x-guest': '1' } })).toMatchObject({ status: 403, body: { code: 'local_only' } });
    expect(await call('/api/inbox/system/projects', [a], { headers: { origin: 'https://evil.example' } })).toMatchObject({ status: 403, body: { code: 'cross_origin' } });
    expect(await call('/api/inbox/system/drawing', [a], { query: '?project=prj_nope' })).toMatchObject({ status: 422, body: { code: 'validation_error' } });
    expect(listed).toBe(0);
  });
});
