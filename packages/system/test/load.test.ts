import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { citations, drawingProgress, drawingStatus, FORMAT, formatIssue, loadFiles, parseRevision, type SystemFiles } from '../src/index.ts';
import { load } from '../src/node/index.ts';
import { drawingDir, edited, fixturesDir, smallDrawing } from './helpers.ts';

/** Each error as one line: `<file> <field>: <message>`. */
const errorsOf = (files: SystemFiles) => loadFiles(files).errors.map(formatIssue);
const sysEdit = (edit: (t: string) => string) => edited('system.yaml', edit);

/** Every text file under a folder, by its path. */
function textsUnder(dir: string): [string, string][] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => /\.(ya?ml|json|txt|ts)$/.test(p))
    .map((p) => [p, readFileSync(p, 'utf8')]);
}

// The names a fixture or the drawing may give a person. Any other two
// capitalized words in a person's slot (people parts, "by", authors) fail.
const ALLOWED_PEOPLE = new Set(['Maya Chen', 'Alex Rivera']);

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
      expect(model!.parts[id]!.marks).toEqual([]);
    }
  });

  test('the drawing and the tests hold no private path, private repo alias or real person', async () => {
    const texts = [...textsUnder(drawingDir), ...textsUnder(join(fixturesDir, '..'))];
    expect(texts.length).toBeGreaterThan(10);
    const names = new Set<string>();
    for (const [path, t] of texts) {
      expect({ path, hit: /(^|[\s{,"'])ws:/m.exec(t)?.[0] ?? null }).toEqual({ path, hit: null });
      expect({ path, hit: /\/Users\/|\/home\/|\/private\/var\//.exec(t)?.[0] ?? null }).toEqual({ path, hit: null });
      // a person's name sits in a people part's name, a git identity, a "by" or an author
      for (const m of [
        ...t.matchAll(/\{\s*name:\s*([^,}]+?),\s*kind:\s*(?:people|person)\b/g),
        ...t.matchAll(/^\s*name:\s*(.+)\n\s*kind:\s*(?:people|person)\s*$/gm),
        ...t.matchAll(/user\.name=([^'"]+)/g),
        ...t.matchAll(/["']?\b(?:by|author)["']?:\s*["']?([A-Z][a-z]+ [A-Z][a-z]+)/g),
      ]) {
        const name = m[1]!.trim().replace(/^["']|["']$/g, '');
        if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(name)) names.add(`${name} (${path.slice(path.indexOf('packages/') >= 0 ? path.indexOf('packages/') : 0)})`);
      }
    }
    const people = [...names].map((n) => n.replace(/ \(.*$/, ''));
    // the scan finds the fixture people, so it would find another name too
    expect(people).toContain('Maya Chen');
    expect([...names].filter((n) => !ALLOWED_PEOPLE.has(n.replace(/ \(.*$/, '')))).toEqual([]);
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

  test('a higher format, with one plain error and no model', () => {
    const r = loadFiles(sysEdit((t) => t.replace('format: 1', 'format: 2')));
    expect(r.model).toBeNull();
    expect(r.errors).toEqual([{ file: 'system.yaml', field: '', message: 'this drawing is format 2; this Plannotator reads format 1' }]);
  });

  test('no format, or a format that is not a number', () => {
    const none = errorsOf(sysEdit((t) => t.replace('format: 1\n', '')));
    expect(none).toHaveLength(1);
    expect(none[0]).toContain('system.yaml format: this drawing has no format');
    expect(errorsOf(sysEdit((t) => t.replace('format: 1', 'format: true')))).toEqual([
      'system.yaml format: "true" is not a format number; this Plannotator reads format 1',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('format: 1', 'format: "1"')))).toHaveLength(1);
  });

  test('a coordinate, naming the file and the field', () => {
    expect(loadFiles(edited('sheets/L-101.yaml', (t) => t.replace('{ id: inside,', '{ id: inside, x: 40,'))).errors).toContainEqual({
      file: 'sheets/L-101.yaml', field: 'bands[0].x', message: 'coordinates are not allowed; place parts by band, order and span',
    });
  });

  test('but not a part named like one', () => {
    expect(errorsOf(sysEdit((t) => t.replace('  api:', '  x: { in: app, name: X }\n  api:')))).toEqual([]);
  });

  test('each dropped key, naming why', () => {
    expect(errorsOf(sysEdit((t) => t.replace('kind: people }', 'kind: people, history: [] }')))).toEqual([
      'system.yaml parts.person.history: "history" is not in format 1 (the Inbox owns pull request, issue and thread data)',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('says: uses it,', 'says: uses it, rate: 3/s,')))).toEqual([
      'system.yaml flows.use.rate: "rate" is not in format 1 (a performance number; an overlay carries it, never the drawing)',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('kind: people }', 'kind: people, charts: [] }')))).toEqual([
      'system.yaml parts.person.charts: "charts" is not in format 1 (invented numbers; a drawing made from code has none)',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('system: Small', 'system: Small\nsample: made up')))[0]).toContain('"sample" is not in format 1');
  });

  test('a part in an unknown scope', () => {
    expect(errorsOf(sysEdit((t) => t.replace('{ in: app, name: API', '{ in: nowhere, name: API')))).toContain(
      'system.yaml parts.api.in: unknown scope "nowhere"',
    );
  });

  test('a scope opened twice, a scope no part opens, and a part that opens root', () => {
    expect(errorsOf(sysEdit((t) => t.replace('kind: people }', 'kind: people, child: app }')))).toContain(
      'system.yaml parts.app.child: scope "app" is opened by both person and app',
    );
    expect(errorsOf(sysEdit((t) => t.replace('app: The app }', 'app: The app, spare: Nothing }')))).toEqual([
      'system.yaml scopes.spare: no part opens this scope (a part with child: spare)',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('kind: people }', 'kind: people, child: root }')))).toEqual([
      'system.yaml parts.person.child: opens root, the landing scope',
    ]);
  });

  test('a scope inside itself', () => {
    const files = sysEdit((t) =>
      t
        .replace('app: The app }', 'app: The app, a: A, b: B }')
        .replace('  api:', '  pa: { in: b, name: PA, child: a }\n  pb: { in: a, name: PB, child: b }\n  api:'),
    );
    const errors = errorsOf(files);
    expect(errors).toContain('system.yaml scopes.a: is inside itself');
    expect(errors).toContain('system.yaml scopes.b: is inside itself');
  });

  test('a line with the id of a part', () => {
    expect(errorsOf(sysEdit((t) => t.replace('  use: {', '  api: { from: person, to: app }\n  use: {')))).toEqual([
      'system.yaml flows.api: has the id of a part; a line and a part need different ids',
    ]);
  });

  test('a text an unquoted comma split', () => {
    const r = errorsOf(sysEdit((t) => t.replace('says: uses it,', 'says: uses it, every day,')));
    expect(r[0]).toContain('unknown key "every day" on a flow (an unquoted comma inside { } splits a text; quote it)');
  });

  test('a code path outside the repo, climbing out with .., or in a repo sources does not list', () => {
    const one = (from: string, to: string) => errorsOf(sysEdit((t) => t.replace(from, to)));
    expect(one('src/main.ts: the entry', '/opt/main.ts: the entry')).toEqual([
      'system.yaml parts.app.code: "/opt/main.ts" is not a path in a repo; cite it relative to the repo\'s root',
    ]);
    expect(one('src/main.ts: the entry', 'src/../../etc/passwd: the entry')).toEqual([
      'system.yaml parts.app.code: "src/../../etc/passwd" climbs out of the repo with ..',
    ]);
    expect(one('code: { to: src/api/index.ts }', 'code: { to: "self:../x.ts" }')).toEqual([
      'system.yaml flows.use.code.to: "self:../x.ts" climbs out of the repo with ..',
    ]);
    expect(one('src/main.ts: the entry', 'other:src/main.ts: the entry')).toEqual([
      'system.yaml parts.app.code: "other:src/main.ts" names the repo "other", which sources.repos does not list',
    ]);
  });

  test('a commit that is not one', () => {
    expect(errorsOf(sysEdit((t) => t.replace('at: 1a2b3c4', 'at: main')))).toEqual([
      'system.yaml sources.repos.self.at: should be the commit it was drawn from (7 to 40 hex digits), not "main"',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('at: 1a2b3c4', 'at: 1234567')))).toEqual([
      'system.yaml sources.repos.self.at: reads as a number; put the commit in quotes',
    ]);
  });

  test('a landing sheet that is not of the root scope', () => {
    const r = loadFiles(sysEdit((t) => t.replace('root: C-001', 'root: L-101')));
    expect(r.errors.map(formatIssue)).toEqual(['system.yaml root: L-101 is a sheet of scope "app", not of root']);
    expect(r.model).not.toBeNull();
  });

  test('a sheet whose code does not match its kind or its file', () => {
    expect(errorsOf(edited('sheets/L-101.yaml', (t) => t.replace('kind: logical', 'kind: flow')))).toContain(
      "sheets/L-101.yaml sheet: a flow sheet's code starts with F, not L",
    );
    // a second copy of a sheet under another name fails on its file name, so no sheet is drawn twice
    const files = smallDrawing();
    files['sheets/L-102.yaml'] = files['sheets/L-101.yaml']!;
    expect(errorsOf(files)).toEqual(['sheets/L-102.yaml sheet: says L-101; the file of sheet L-101 is sheets/L-101.yaml']);
  });

  test('a line to an unknown part, and a sheet showing an unknown line', () => {
    expect(errorsOf(sysEdit((t) => t.replace('to: app, says', 'to: ghost, says')))).toContain('system.yaml flows.use: names unknown part "ghost"');
    expect(errorsOf(edited('sheets/C-001.yaml', (t) => t.replace('show: [use]', 'show: [use, nope]')))).toEqual([
      'sheets/C-001.yaml show: unknown line "nope"',
      // the sheet is left out, so the landing it was is named too
      'system.yaml root: sheet C-001 did not load (see sheets/C-001.yaml)',
    ]);
  });

  test('a .yml file, by name', () => {
    const files = smallDrawing();
    files['sheets/F-101.yml'] = 'sheet: F-101\n';
    expect(errorsOf(files)).toEqual(['sheets/F-101.yml: a drawing file ends in .yaml: rename it sheets/F-101.yaml']);
    expect(loadFiles({ 'system.yml': 'format: 1\n' })).toEqual({
      model: null, warnings: [], errors: [{ file: 'system.yml', field: '', message: 'a drawing file ends in .yaml: rename it system.yaml' }],
    });
  });

  test('a file over 1 MiB, and a drawing over 8 MiB', () => {
    const files = smallDrawing();
    files['revisions/PR-1.yaml'] = `revision: PR-1\ntitle: ${'x'.repeat(1024 * 1024)}\n`;
    const r = loadFiles(files);
    expect(r.errors.map((e) => [e.file, e.message.split(';')[1]])).toEqual([['revisions/PR-1.yaml', ' this Plannotator reads at most 1048576 bytes in one file']]);
    expect(r.model).not.toBeNull();
    for (let i = 0; i < 9; i++) files[`revisions/PR-${i}.yaml`] = 'x'.repeat(1024 * 1024 - 10);
    const huge = loadFiles(files);
    expect(huge.model).toBeNull();
    expect(huge.errors).toHaveLength(1);
    expect(huge.errors[0]!.message).toContain('this Plannotator reads at most 8388608 bytes in one drawing');
  });
});

describe('names every JavaScript object carries', () => {
  test('a scope named constructor, toString or __proto__ is an error, not a crash', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const files = sysEdit((t) => t.replace('{ in: app, name: API', `{ in: ${name}, name: API`));
      expect(() => loadFiles(files)).not.toThrow();
      expect(errorsOf(files)).toContain(`system.yaml parts.api.in: unknown scope "${name}"`);
    }
    const scoped = sysEdit((t) => t.replace('app: The app }', 'app: The app, constructor: C }'));
    expect(errorsOf(scoped)).toEqual(['system.yaml scopes.constructor: "constructor" is a reserved name; pick another id']);
  });

  test('a part, a line or a stack entry with a reserved id is refused, not dropped', () => {
    expect(errorsOf(sysEdit((t) => t.replace('  api:', '  __proto__: { in: app, name: P }\n  api:')))).toEqual([
      'system.yaml parts.__proto__: "__proto__" is a reserved name; pick another id',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('  use:', '  prototype: { from: person, to: app }\n  use:')))).toEqual([
      'system.yaml flows.prototype: "prototype" is a reserved name; pick another id',
    ]);
    expect(errorsOf(sysEdit((t) => `${t}stack:\n  constructor: { name: C }\n`))).toEqual([
      'system.yaml stack.constructor: "constructor" is a reserved name; pick another id',
    ]);
  });

  test('a band cell, a line end or a shown line named like a built-in is unknown', () => {
    expect(errorsOf(edited('sheets/L-101.yaml', (t) => t.replace('row: [api]', 'row: [api, hasOwnProperty]')))).toEqual([
      'sheets/L-101.yaml: unknown part "hasOwnProperty"',
      'system.yaml flows.use.lands: "api", which no sheet inside The app draws',
    ]);
    expect(errorsOf(sysEdit((t) => t.replace('to: app, says', 'to: toString, says')))).toContain('system.yaml flows.use: names unknown part "toString"');
    expect(errorsOf(edited('sheets/C-001.yaml', (t) => t.replace('show: [use]', 'show: [use, valueOf]')))).toEqual([
      'sheets/C-001.yaml show: unknown line "valueOf"',
      'system.yaml root: sheet C-001 did not load (see sheets/C-001.yaml)',
    ]);
  });

  test('a revision naming a built-in is refused', () => {
    const model = loadFiles(smallDrawing()).model!;
    expect(parseRevision(model, 'revision: PR-1\nchange: { toString: x }\n').errors.map(formatIssue)).toEqual([
      'revision change.toString: names unknown part or line "toString"',
    ]);
    expect(parseRevision(model, 'revision: PR-1\nlines: { constructor: "+1" }\n').errors.map(formatIssue)).toEqual([
      'revision lines.constructor: names unknown part "constructor"',
    ]);
    expect(parseRevision(model, 'revision: PR-1\nadd: { parts: { __proto__: { name: X } } }\n').errors.map(formatIssue)).toEqual([
      'revision add.parts.__proto__: "__proto__" is a reserved name; pick another id',
    ]);
    expect(parseRevision(model, 'revision: constructor\n').revision).toBeNull();
  });
});

describe('a drawing part way through', () => {
  const wanting = (codes: string[]) =>
    sysEdit((t) => `${t}wanted:\n${codes.map((c) => `  - { code: ${c}, kind: flow, question: "Sheet ${c}." }`).join('\n')}\n`);

  test('a half-written wanted sheet is left out, with its errors, and the rest loads', () => {
    const files = wanting(['F-101', 'F-102']);
    files['sheets/F-101.yaml'] = 'sheet: F-101\nscope: root\nkind: flow\ntitle: One request\nlanes: [person, ap';
    const r = loadFiles(files);
    expect(r.model).not.toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(new Set(r.errors.map((e) => e.file))).toEqual(new Set(['sheets/F-101.yaml']));
    expect(Object.keys(r.model!.sheets).sort()).toEqual(['C-001', 'L-101']);
    expect(drawingStatus(r)).toEqual({ state: 'drawing', sheets: 2, wanted: 2, drawnAt: '1a2b3c4' });
    expect(drawingProgress(r.model!).sheets.map((s) => [s.code, s.drawn])).toEqual([
      ['L-101', true], ['C-001', true], ['F-101', false], ['F-102', false],
    ]);
  });

  test('a broken sheet nothing wants still leaves the model, and the drawing is broken', () => {
    const r = loadFiles(edited('sheets/L-101.yaml', (t) => t.replace('row: [api]', 'row: [ghost]')));
    expect(r.model).not.toBeNull();
    expect(Object.keys(r.model!.sheets)).toEqual(['C-001']);
    // the line lands on api, which only L-101 drew
    expect(r.errors.map(formatIssue)).toEqual([
      'sheets/L-101.yaml: unknown part "ghost"',
      'system.yaml flows.use.lands: "api", which no sheet inside The app draws',
    ]);
    expect(drawingStatus(r)).toEqual({ state: 'broken', sheets: 1, wanted: 0, drawnAt: '1a2b3c4' });
  });

  test('a landing sheet that did not load is named', () => {
    const r = loadFiles(edited('sheets/C-001.yaml', (t) => t.replace('kind: conceptual', 'kind: conceptual\nbogus: 1')));
    expect(r.errors.map(formatIssue)).toEqual([
      'sheets/C-001.yaml bogus: unknown key "bogus" on a sheet',
      'system.yaml root: sheet C-001 did not load (see sheets/C-001.yaml)',
    ]);
  });

  test('a broken revision is left out and the rest is kept', () => {
    const files = smallDrawing();
    files['revisions/PR-1.yaml'] = 'revision: PR-1\nchange: { api: Faster. }\n';
    files['revisions/PR-2.yaml'] = 'revision: PR-2\nchange: { ghost: x }\n';
    const r = loadFiles(files);
    expect(Object.keys(r.model!.revisions)).toEqual(['PR-1']);
    expect(r.errors.map(formatIssue)).toEqual(['revisions/PR-2.yaml change.ghost: names unknown part or line "ghost"']);
  });

  test('an error in system.yaml leaves no model', () => {
    const r = loadFiles(sysEdit((t) => t.replace('{ in: app, name: API', '{ in: nowhere, name: API')));
    expect(r.model).toBeNull();
    expect(drawingStatus(r)).toEqual({ state: 'broken', sheets: 0, wanted: 0, drawnAt: null });
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
      { file: 'revision', field: 'state', message: '"state" is not in format 1 (whether a pull request is open or merged comes from the forge, not the file)' },
      { file: 'revision', field: 'change.ghost', message: 'names unknown part or line "ghost"' },
    ]);
  });

  test('a merged PR names with ~ only what the drawing has', () => {
    expect(parseRevision(model, 'revision: PR-9\nadd: { parts: { api: ~, queue: ~ } }\n').errors.map(formatIssue)).toEqual([
      'revision add.parts.queue: is ~, but the drawing has no part "queue"',
    ]);
  });
});

describe('status and progress', () => {
  test('none, drawing, drawn and broken', () => {
    expect(drawingStatus(null).state).toBe('none');
    expect(drawingStatus(loadFiles({})).state).toBe('none');
    expect(drawingStatus(loadFiles(smallDrawing()))).toEqual({ state: 'drawn', sheets: 2, wanted: 0, drawnAt: '1a2b3c4' });
    const drawing = loadFiles(sysEdit((t) => `${t}wanted:\n  - { code: F-101, kind: flow, question: "One request, hop by hop." }\n`));
    expect(drawingStatus(drawing)).toMatchObject({ state: 'drawing', sheets: 2, wanted: 1 });
    expect(drawingStatus(loadFiles(sysEdit((t) => t.replace('format: 1', 'format: 9')))).state).toBe('broken');
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
    const r = loadFiles(sysEdit((t) => `${t}wanted:\n  - { code: L-101, kind: logical, question: x }\n  - { code: F-101, kind: flow, question: y }\n`));
    expect(r.warnings.map(formatIssue)).toEqual(['system.yaml wanted: sheet L-101 is drawn; take it out of wanted']);
    // only the sheets not drawn yet are wanted
    expect(drawingStatus(r)).toMatchObject({ state: 'drawing', wanted: 1 });
    expect(drawingProgress(r.model!).sheets.map((s) => [s.code, s.drawn])).toEqual([['L-101', true], ['C-001', true], ['F-101', false]]);
  });
});
