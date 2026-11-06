import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { citations, drawingProgress, drawingStatus, FORMAT, loadFiles, parseRevision } from '../src/index.ts';
import { load } from '../src/node/index.ts';
import { drawingDir, edited, fixturesDir, smallDrawing } from './helpers.ts';

const errorsOf = (files: Record<string, string>) => loadFiles(files).errors;

describe('the committed drawing', () => {
  test('loads with no errors and no warnings', async () => {
    const r = await load(drawingDir);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.model?.format).toBe(FORMAT);
    expect(Object.keys(r.model!.sheets).sort()).toEqual(['C-001', 'F-101', 'F-201', 'L-101', 'L-201', 'T-001']);
    expect(Object.keys(r.model!.revisions).sort()).toEqual(['PR-2543', 'PR-2563']);
  });

  // This repo is open source: the drawing may cite only this repo. Workspaces
  // and the desktop app are drawn as outside parts with no code at all.
  test('cites only this repo, and no path outside it', async () => {
    const { model } = await load(drawingDir);
    expect(Object.keys(model!.sources!.repos)).toEqual(['self']);
    expect(citations(model!).filter((c) => c.repo !== 'self')).toEqual([]);
    for (const id of ['desktop', 'workspaces']) {
      expect(model!.parts[id]!.code).toEqual([]);
      expect(model!.parts[id]!.child).toBeNull();
    }
    const texts = ['system.yaml', ...readdirSync(join(drawingDir, 'sheets')).map((f) => `sheets/${f}`), ...readdirSync(join(drawingDir, 'revisions')).map((f) => `revisions/${f}`)]
      .map((f) => readFileSync(join(drawingDir, f), 'utf8'));
    for (const t of texts) {
      expect(t).not.toMatch(/(^|[\s{,"'])ws:/m);
      expect(t).not.toMatch(/\/Users\/|\/home\//);
    }
  });
});

describe('the worst-case fixtures', () => {
  const g = JSON.parse(readFileSync(join(fixturesDir, 'g-loader-summary.json'), 'utf8'));
  for (const name of ['worst-case', 'worst-one', 'worst-huge']) {
    test(`${name} loads as the prototype loader read it`, async () => {
      const r = await load(join(fixturesDir, name));
      const want = g[name];
      expect({ errors: r.errors, warnings: r.warnings }).toEqual({ errors: want.errors, warnings: want.warnings });
      const m = r.model!;
      expect(m.root).toBe(want.root);
      expect(Object.keys(m.parts).sort()).toEqual(want.parts);
      expect(Object.keys(m.flows).sort()).toEqual(want.flows);
      expect(m.byScope).toEqual(want.byScope);
      expect(m.owner).toEqual(want.owner);
      expect(m.parentOf).toEqual(want.parentOf);
      expect(Object.keys(m.revisions).sort()).toEqual(want.revisions);
    });
  }
});

describe('format 1 refuses', () => {
  test('a small drawing loads clean, so every refusal below is the one change it makes', () => {
    expect(loadFiles(smallDrawing())).toMatchObject({ errors: [], warnings: [] });
  });

  test('a higher format, with one plain error', () => {
    const r = loadFiles(edited('system.yaml', (t) => t.replace('format: 1', 'format: 2')));
    expect(r.model).toBeNull();
    expect(r.errors).toEqual(['system.yaml: this drawing is format 2; this Plannotator reads format 1']);
  });

  test('no format at all', () => {
    const r = errorsOf(edited('system.yaml', (t) => t.replace('format: 1\n', '')));
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('has no format');
  });

  test('a coordinate', () => {
    expect(errorsOf(edited('sheets/L-101.yaml', (t) => t.replace('{ id: inside,', '{ id: inside, x: 40,')))).toEqual([
      'sheets/L-101.yaml.bands[0].x: coordinates are not allowed; place parts by band, order and span',
    ]);
  });

  test('but not a part named like one', () => {
    const r = errorsOf(edited('system.yaml', (t) => t.replace('  api:', '  x: { in: app, name: X }\n  api:')));
    expect(r).toEqual([]);
  });

  test('each dropped key, naming why', () => {
    const history = errorsOf(edited('system.yaml', (t) => t.replace('kind: people }', 'kind: people, history: [] }')));
    expect(history).toEqual(['system.yaml part person: "history" is not in format 1 (the Inbox owns pull request, issue and thread data)']);
    const rate = errorsOf(edited('system.yaml', (t) => t.replace('says: uses it,', 'says: uses it, rate: 3/s,')));
    expect(rate).toEqual(['system.yaml flow use: "rate" is not in format 1 (a performance number; an overlay carries it, never the drawing)']);
    const charts = errorsOf(edited('system.yaml', (t) => t.replace('kind: people }', 'kind: people, charts: [] }')));
    expect(charts).toEqual(['system.yaml part person: "charts" is not in format 1 (invented numbers; a drawing made from code has none)']);
    const sample = errorsOf(edited('system.yaml', (t) => t.replace('system: Small', 'system: Small\nsample: made up')));
    expect(sample[0]).toContain('"sample" is not in format 1');
  });

  test('a part in an unknown scope', () => {
    expect(errorsOf(edited('system.yaml', (t) => t.replace('{ in: app, name: API', '{ in: nowhere, name: API')))).toContain(
      'system.yaml part api: in unknown scope "nowhere"',
    );
  });

  test('a scope opened twice', () => {
    expect(errorsOf(edited('system.yaml', (t) => t.replace('kind: people }', 'kind: people, child: app }')))).toContain(
      'system.yaml: scope "app" is opened by both person and app',
    );
  });

  test('a text an unquoted comma split', () => {
    const r = errorsOf(edited('system.yaml', (t) => t.replace('says: uses it,', 'says: uses it, every day,')));
    expect(r[0]).toContain('unknown key "every day" on a flow (an unquoted comma inside { } splits a text; quote it)');
  });

  test('a code path outside the repo, and one in a repo sources does not list', () => {
    expect(errorsOf(edited('system.yaml', (t) => t.replace('src/main.ts: the entry', '/opt/main.ts: the entry')))[0]).toContain('is not a path in a repo');
    expect(errorsOf(edited('system.yaml', (t) => t.replace('src/main.ts: the entry', 'other:src/main.ts: the entry')))[0]).toContain(
      'names the repo "other", which sources.repos does not list',
    );
  });

  test('a sheet whose code does not match its kind or its file', () => {
    expect(errorsOf(edited('sheets/L-101.yaml', (t) => t.replace('kind: logical', 'kind: flow')))).toContain(
      "sheets/L-101.yaml: a flow sheet's code starts with F, not L",
    );
    const files = smallDrawing();
    files['sheets/L-102.yaml'] = files['sheets/L-101.yaml']!;
    delete files['sheets/L-101.yaml'];
    expect(errorsOf(files)[0]).toContain('says sheet L-101; the file of sheet L-101 is sheets/L-101.yaml');
  });

  test('a line to an unknown part, and a sheet showing an unknown line', () => {
    expect(errorsOf(edited('system.yaml', (t) => t.replace('to: app, says', 'to: ghost, says')))).toContain('system.yaml flow use: names unknown part "ghost"');
    expect(errorsOf(edited('sheets/C-001.yaml', (t) => t.replace('show: [use]', 'show: [use, nope]')))).toEqual(['sheets/C-001.yaml: shows unknown line "nope"']);
  });
});

describe('revisions', () => {
  const model = loadFiles(smallDrawing()).model!;

  test('an open PR adds a part in full and places it', () => {
    const { revision, errors } = parseRevision(model, [
      'revision: PR-7',
      'scope: app',
      'title: A queue',
      'pr: 7',
      'add:',
      '  parts: { queue: { in: app, name: Queue, code: { src/queue.ts: the queue } } }',
      '  flows: { enqueue: { from: api, to: queue, says: puts jobs } }',
      '  place: { L-101: { queue: { band: inside, after: api } } }',
      'change: { api: Puts slow work on the queue. }',
      'lines: { api: "index.ts · +12" }',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(revision!.add.parts.queue!.code).toEqual([{ repo: 'self', path: 'src/queue.ts', note: 'the queue' }]);
    expect(revision!.place['L-101']!.queue).toEqual({ band: 'inside', after: 'api', span: null });
  });

  test('a broken revision is refused, naming the field', () => {
    const { revision, errors } = parseRevision(model, 'revision: PR-8\nstate: open\nchange: { ghost: gone }\nlines: { api: "+1" }\n');
    expect(revision).toBeNull();
    expect(errors).toEqual([
      'revision: "state" is not in format 1 (whether a pull request is open or merged comes from the forge, not the file)',
      'revision: change names unknown part or line "ghost"',
    ]);
  });

  test('a merged PR names with ~ only what the drawing has', () => {
    expect(parseRevision(model, 'revision: PR-9\nadd: { parts: { api: ~, queue: ~ } }\n').errors).toEqual([
      'revision: add parts queue is ~, but the drawing has no part "queue"',
    ]);
  });
});

describe('status and progress', () => {
  test('none, drawing, drawn and broken', () => {
    expect(drawingStatus(null).state).toBe('none');
    expect(drawingStatus(loadFiles({})).state).toBe('none');
    expect(drawingStatus(loadFiles(smallDrawing()))).toEqual({ state: 'drawn', sheets: 2, wanted: 0, drawnAt: '1a2b3c4' });
    const drawing = loadFiles(edited('system.yaml', (t) => `${t}wanted:\n  - { code: F-101, kind: flow, question: "One request, hop by hop." }\n`));
    expect(drawingStatus(drawing)).toMatchObject({ state: 'drawing', sheets: 2, wanted: 1 });
    expect(drawingStatus(loadFiles(edited('system.yaml', (t) => t.replace('format: 1', 'format: 9')))).state).toBe('broken');
  });

  test('the first draw: system.yaml alone, every sheet wanted, loads as drawing', () => {
    const r = loadFiles({
      'system.yaml': 'format: 1\nsystem: New\nroot: C-001\nscopes: { root: New }\nwanted:\n  - { code: C-001, kind: conceptual, question: What it is. }\n  - { code: L-101, kind: logical, question: What talks to what. }\n',
    });
    expect(r.errors).toEqual([]);
    expect(drawingStatus(r)).toMatchObject({ state: 'drawing', sheets: 0, wanted: 2 });
    expect(drawingProgress(r.model!).sheets.map((s) => [s.code, s.drawn])).toEqual([['C-001', false], ['L-101', false]]);
  });

  test('a sheet drawn and still wanted is a warning, so check is not clean', () => {
    const r = loadFiles(edited('system.yaml', (t) => `${t}wanted:\n  - { code: L-101, kind: logical, question: x }\n`));
    expect(r.warnings).toEqual(['system.yaml wanted: sheet L-101 is drawn; take it out of wanted']);
    expect(drawingProgress(r.model!).sheets.map((s) => [s.code, s.drawn])).toEqual([['L-101', true], ['C-001', true]]);
  });
});
