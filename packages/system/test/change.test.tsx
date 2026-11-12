/**
 * The change on the drawing (step A5): a revision or the gate's result applied
 * to plannotator's own drawing (the fixture), over its two revisions
 * (PR 2543 and PR 2563) and their real files from git history.
 *
 * What is proved, without a DOM: After marks the parts and lines a PR adds
 * green and the ones it changes amber, numbered in the order the parts list
 * reads; Before hides what the PR added; a removed part and its lines are
 * drawn grey and struck in After and plain in Before; Steps lays the
 * revision's one sequence out with each step's ink; an open PR's full entries
 * are placed into the sheet; the gate's result marks touched parts amber only;
 * a plan has no PR; the summary credits a part only with PR files its own
 * cited paths cover, and its counts are those files' counts.
 * Several open PRs at rest (`touches`): each touched part amber and labelled
 * with every PR that touches it, past two the first and how many more.
 *
 * With a DOM (DOM_TESTS=1, happy-dom, from tests/dom-test-list.txt): the view
 * draws those marks, its tally says what changeSummary says, the parts list's
 * "diff" opens a credited file only, Steps and Esc, the plan's dashed class,
 * and the card picture's one control; the touches' labels and hover, a
 * revision beating them, and the leading slot first in the bar.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyChange, changeSummary, changeWords, gate, hasSteps, loadFiles, parseRevision, STEPS_CODE, type ChangeFile, type GateResult, type Revision, type SystemFiles, type SystemModel } from '../src/index.ts';
import { readFiles } from '../src/node/index.ts';
import { layoutSheet } from '../src/layout/compose.ts';
import { before2563, OPEN_2563, PLAN, prFiles, REMOVES, TOUCHES } from './fixtures/change.ts';
import { applyTouches, touchWords } from '../src/change/apply.ts';
import { drawingDir } from './helpers.ts';

const hasDom = typeof document !== 'undefined';
const R = (hasDom ? await import('../src/react.ts') : {}) as typeof import('../src/react.ts');

let files: SystemFiles;
let model: SystemModel;
const pr: Record<number, ChangeFile[]> = {};
const rev = (src: string, m = model): Revision => {
  const { revision, errors } = parseRevision(m, src);
  expect(errors).toEqual([]);
  return revision!;
};
const touchesOf = () => TOUCHES.map((t) => ({ label: t.label, change: gate({ files: t.files, model }) }));
const gateOf = (n: number): GateResult => gate({ files: pr[n]!.map((f) => ({ ...f, status: f.status ?? 'M' })), model });

beforeAll(async () => {
  files = (await readFiles(drawingDir)).files;
  const loaded = loadFiles(files);
  expect(loaded.errors).toEqual([]);
  model = loaded.model!;
  pr[2543] = prFiles(2543);
  pr[2563] = prFiles(2563);
});

function marks(m: SystemModel, code: string) {
  const L = layoutSheet(m, code);
  const parts = Object.fromEntries(Object.entries(L.parts).filter(([, p]) => p.status).map(([id, p]) => [id, p.status]));
  const nums = Object.fromEntries(Object.entries(L.parts).filter(([, p]) => p.n).map(([id, p]) => [id, p.n]));
  const lines = Object.fromEntries(L.edges.filter((e) => e.status).map((e) => [e.id, e.status]));
  return { L, parts, nums, lines };
}

describe('a merged PR on its drawing', () => {
  test('PR 2563 After: T3 Code green and numbered first, the shim and the Inbox server amber, its two lines green', () => {
    const r = model.revisions['PR-2563']!;
    const s = changeSummary(model, r, pr[2563]);
    expect(s.sheet).toBe('L-201');
    const { parts, nums, lines } = marks(applyChange(model, r, 'after', pr[2563]), 'L-201');
    expect(parts).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
    for (const [i, p] of s.parts.entries()) expect([p.id, nums[p.id]]).toEqual([p.id, i + 1]);
    expect(lines).toEqual({ i_t3stdio: 'added', i_wt3: 'added' });
  });

  test('PR 2563 Before: no T3 Code, no line to it, nothing marked', () => {
    const r = model.revisions['PR-2563']!;
    const { L, parts, lines } = marks(applyChange(model, r, 'before', pr[2563]), 'L-201');
    expect('it3' in L.parts).toBe(false);
    expect(L.edges.some((e) => e.id === 'i_t3stdio' || e.id === 'i_wt3')).toBe(false);
    expect([parts, lines]).toEqual([{}, {}]);
  });

  test('PR 2543: the ping is green on the sheet that draws it and gone in Before; its lines go with it', () => {
    const r = model.revisions['PR-2543']!;
    const after = marks(applyChange(model, r, 'after', pr[2543]), 'C-001');
    expect(after.parts.ping).toBe('added');
    expect(after.lines.cliping).toBe('added');
    const before = layoutSheet(applyChange(model, r, 'before', pr[2543]), 'C-001');
    expect('ping' in before.parts).toBe(false);
    expect(before.edges.some((e) => e.id === 'cliping' || e.id === 'inboxping')).toBe(false);
  });

  test('the summary says what the drawing marks: "1 part added, 7 changed" and "1 part added, 2 changed"', () => {
    expect(changeWords(changeSummary(model, model.revisions['PR-2543']!, pr[2543]))).toBe('1 part added, 7 changed');
    expect(changeWords(changeSummary(model, model.revisions['PR-2563']!, pr[2563]))).toBe('1 part added, 2 changed');
  });

  test('a part is credited only with files the PR changed and its own cited paths cover; its counts are those files', () => {
    for (const n of [2543, 2563]) {
      const r = model.revisions['PR-' + n]!;
      const s = changeSummary(model, r, pr[n]);
      const byPath = new Map(pr[n]!.map((f) => [f.path, f]));
      for (const p of s.parts) {
        const cited = (model.parts[p.id] ?? r.add.parts[p.id])?.code.filter((c) => c.repo === 'self').map((c) => c.path) ?? [];
        for (const f of p.files) {
          expect([n, p.id, f, byPath.has(f)]).toEqual([n, p.id, f, true]);
          expect([n, p.id, f, cited.some((c) => f === c || f.startsWith(c.replace(/\/?$/, '/')))]).toEqual([n, p.id, f, true]);
        }
        if (p.files.length) {
          const add = p.files.reduce((k, f) => k + (byPath.get(f)!.additions ?? 0), 0);
          expect([p.id, p.lines?.includes(`+${add}`)]).toEqual([p.id, true]);
        }
      }
    }
    const all = changeSummary(model, model.revisions['PR-2543']!, pr[2543]).parts.flatMap((p) => p.files);
    expect(all).not.toContain('.github/workflows/release.yml');
    expect(all.filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });

  test('without the PR\'s files a part keeps only the cited files its written counts name', () => {
    const r = model.revisions['PR-2563']!;
    for (const p of changeSummary(model, r).parts) {
      const written = r.lines[p.id] ?? '';
      for (const f of p.files) expect([p.id, f, written.includes(f.slice(f.lastIndexOf('/') + 1))]).toEqual([p.id, f, true]);
    }
  });
});

test('Steps: the revision\'s sequence as a sheet of its own, each step in its ink', () => {
  for (const id of ['PR-2543', 'PR-2563']) {
    const r = model.revisions[id]!;
    expect(hasSteps(r)).toBe(true);
    const m = applyChange(model, r, 'steps', pr[Number(id.slice(3))]);
    const L = layoutSheet(m, STEPS_CODE);
    const hops = r.steps!.hops;
    expect(m.sheets[STEPS_CODE]!.hops.length).toBe(hops.length);
    expect(L.title).toBe(r.steps!.title);
    const want = Object.fromEntries(hops.map((h, i) => [`${STEPS_CODE}.s${i + 1}`, h.is ?? null]).filter(([, v]) => v));
    const got = Object.fromEntries([
      ...L.edges.filter((e) => e.status).map((e) => [e.id, e.status]),
      ...L.figures.filter((f) => f.status && f.type === 'step').map((f) => [f.id, f.status]),
    ]);
    expect(got).toEqual(want);
  }
});

test('a removed part and its lines are grey in After and plain in Before', () => {
  const r = rev(REMOVES);
  const s = changeSummary(model, r);
  expect(changeWords(s)).toBe('1 part changed, 1 removed');
  const after = marks(applyChange(model, r, 'after'), s.sheet);
  expect(after.parts).toEqual({ iserver: 'changed', irelayc: 'removed' });
  expect(after.lines.i_relay).toBe('removed');
  const before = marks(applyChange(model, r, 'before'), s.sheet);
  expect('irelayc' in before.L.parts).toBe(true);
  expect([before.parts, before.lines]).toEqual([{}, {}]);
});

test('an open PR\'s full entries are placed: T3 Code joins the agents band in After and is absent in Before', () => {
  const base = loadFiles(before2563(files)).model!;
  expect('it3' in base.parts).toBe(false);
  const r = rev(OPEN_2563, base);
  expect(r.merged).toBeFalsy();
  const after = marks(applyChange(base, r, 'after', pr[2563]), 'L-201');
  expect(after.parts).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
  expect(after.L.parts.it3!.band).toBe('agents');
  expect(after.lines).toEqual({ i_t3stdio: 'added', i_wt3: 'added' });
  expect('it3' in layoutSheet(applyChange(base, r, 'before', pr[2563]), 'L-201').parts).toBe(false);
  expect(changeSummary(base, r, pr[2563]).parts.find((p) => p.id === 'it3')!.lines).toMatch(/\+\d+/);
});

test('the gate\'s result alone marks touched parts amber, never green or grey, and has no Before or Steps', () => {
  const g = gateOf(2543);
  expect(hasSteps(g)).toBe(false);
  const s = changeSummary(model, g, pr[2543]);
  expect([s.added, s.removed, s.changed]).toEqual([0, 0, g.touched.parts.filter((id) => id in model.parts).length]);
  const m = applyChange(model, g, 'after', pr[2543]);
  for (const code of Object.keys(model.sheets)) {
    const { parts } = marks(m, code);
    expect([code, Object.values(parts).filter((v) => v !== 'changed')]).toEqual([code, []]);
  }
});

test('a plan has no PR and marks what it adds and changes', () => {
  const r = rev(PLAN);
  expect(r.pr ?? null).toBe(null);
  const s = changeSummary(model, r);
  expect(s.sheet).toBe('L-201');
  expect(changeWords(s)).toBe('2 parts added, 2 changed');
  expect(marks(applyChange(model, r, 'after'), 'L-201').parts).toEqual({ isysview: 'added', ikeeper: 'added', iwindow: 'changed', iserver: 'changed' });
});

describe('several open PRs at rest (touches)', () => {
  test('each touched part is amber and labelled with the PRs that touch it, in the order given; the Inbox carries two', () => {
    const { L, parts, nums } = marks(applyTouches(model, touchesOf()), 'C-001');
    expect(parts).toEqual({ ping: 'changed', inbox: 'changed', share: 'changed' });
    expect(nums).toEqual({});
    expect([L.parts.ping!.lines, L.parts.inbox!.lines, L.parts.share!.lines]).toEqual(['PR 101', 'PR 102 · PR 103', 'PR 103']);
    expect(L.parts.inbox!.who).toEqual(['PR 102', 'PR 103']);
  });

  test('the same touches in a new array are the same model; none, or nothing touched, is the drawing itself', () => {
    expect(applyTouches(model, touchesOf())).toBe(applyTouches(model, touchesOf()));
    expect(applyTouches(model, [])).toBe(model);
    expect(applyTouches(model, [{ label: 'PR 104', change: gate({ files: [{ path: 'nowhere/cited.ts', status: 'M' }], model }) }])).toBe(model);
  });

  test('a part touched by more than two PRs shows the first and how many more', () => {
    expect([touchWords(['PR 101']), touchWords(['PR 101', 'PR 102']), touchWords(['PR 101', 'PR 102', 'PR 103'])]).toEqual(['PR 101', 'PR 101 · PR 102', 'PR 101 +2']);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedRect: PropertyDescriptor | undefined;

beforeAll(() => {
  if (!hasDom) return;
  savedRect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) }),
  });
});
afterAll(() => {
  if (savedRect) Object.defineProperty(Element.prototype, 'getBoundingClientRect', savedRect);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}
const noop = () => {};
const status = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('.sys-parts > .sys-part[data-status]')].map((p) => [p.getAttribute('data-part'), p.getAttribute('data-status')]));

test.skipIf(!hasDom)('the view draws PR 2563 After with its inks and numbers, the tally agrees with the summary, and "diff" opens a credited file', async () => {
  const r = model.revisions['PR-2563']!;
  const opened: [string, string][] = [];
  const el = await render(<R.SystemView model={model} revision={r} files={pr[2563]} pr={{ number: 2563, title: r.title, state: 'merged' }} layout="window" onNavigate={noop} onView={noop} onOpenFile={(f, p) => opened.push([f, p])} />);
  const view = el.querySelector('.sys-view')!;
  expect([view.getAttribute('data-sheet'), view.getAttribute('data-view')]).toEqual(['L-201', 'after']);
  expect(status(el)).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
  expect(el.querySelector('[data-part="it3"] .sys-num')!.textContent).toBe('1');
  expect(el.querySelectorAll('.sys-edge.sys-st-added').length).toBeGreaterThanOrEqual(2);
  const s = changeSummary(model, r, pr[2563]);
  expect(el.querySelector('.sys-tally')!.textContent).toBe(`${s.added} added · ${s.changed} changed`);
  const rows = [...el.querySelectorAll('.sys-plist-row[data-row]')];
  expect(rows.map((r) => r.getAttribute('data-row'))).toEqual(s.parts.map((p) => p.id));
  const diffs = [...el.querySelectorAll<HTMLButtonElement>('.sys-plist-diff')];
  expect(diffs.length).toBe(s.parts.filter((p) => p.files.length).length);
  for (const d of diffs) act(() => d.click());
  const paths = new Set(pr[2563]!.map((f) => f.path));
  expect(opened.length).toBe(diffs.length);
  for (const [f, p] of opened) expect([p, f, paths.has(f), s.parts.find((x) => x.id === p)!.files.includes(f)]).toEqual([p, f, true, true]);
  act(() => el.querySelector<HTMLButtonElement>('.sys-plist-row[data-row="shim"] .sys-plist-pick')!.click());
  expect(el.querySelector('.sys-plist-row[aria-current="true"]')!.getAttribute('data-row')).toBe('shim');
});

test.skipIf(!hasDom)('PR 2543: no "diff" for a part none of whose cited files the PR changed', async () => {
  const r = model.revisions['PR-2543']!;
  const opened: string[] = [];
  const el = await render(<R.PartsList model={model} revision={r} files={pr[2543]} onOpenFile={(f) => opened.push(f)} />);
  const s = changeSummary(model, r, pr[2543]);
  for (const p of s.parts) {
    const row = el.querySelector(`.sys-plist-row[data-row="${p.id}"]`)!;
    expect([p.id, !!row.querySelector('.sys-plist-diff')]).toEqual([p.id, p.files.length > 0]);
  }
  for (const b of el.querySelectorAll<HTMLButtonElement>('.sys-plist-diff, button.sys-plist-file')) act(() => b.click());
  const paths = new Set(pr[2543]!.map((f) => f.path));
  expect(opened.length).toBeGreaterThan(0);
  expect(opened.filter((f) => !paths.has(f))).toEqual([]);
});

test.skipIf(!hasDom)('Before draws no mark and no T3 Code; Steps draws the sequence and Esc asks for After', async () => {
  const r = model.revisions['PR-2563']!;
  const before = await render(<R.SystemView model={model} revision={r} files={pr[2563]} view="before" layout="window" onNavigate={noop} onView={noop} />);
  expect(before.querySelector('[data-part="it3"]')).toBe(null);
  expect(before.querySelectorAll('.sys-part[data-status]').length).toBe(0);
  act(() => root!.unmount());
  const asked: string[] = [];
  const el = await render(<R.SystemView model={model} revision={r} files={pr[2563]} view="steps" layout="window" onNavigate={noop} onView={(v) => asked.push(v)} />);
  const steps = el.querySelector('.sys-steps')!;
  expect(steps.getAttribute('aria-label')).toBe(`${r.steps!.title}: ${r.steps!.hops.length} steps`);
  expect(steps.querySelectorAll('.sys-st-added').length).toBeGreaterThan(0);
  expect(el.querySelector('.sys-plist')).toBe(null);
  act(() => { el.querySelector('.sys-view')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(asked).toEqual(['after']);
});

test.skipIf(!hasDom)('an open PR and a gate-only change draw', async () => {
  const base = loadFiles(before2563(files)).model!;
  const open = await render(<R.SystemView model={base} revision={rev(OPEN_2563, base)} files={pr[2563]} layout="window" onNavigate={noop} onView={noop} onOpenFile={noop} />);
  expect(status(open)).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
  act(() => root!.unmount());
  const g = gateOf(2563);
  const el = await render(<R.SystemView model={model} revision={g} files={pr[2563]} layout="window" onNavigate={noop} onView={noop} onOpenFile={noop} />);
  const st = Object.values(status(el));
  expect(st.length).toBeGreaterThan(0);
  expect(st.filter((v) => v !== 'changed')).toEqual([]);
  expect(el.querySelector('[role="radiogroup"]')).toBe(null);
});

test.skipIf(!hasDom)('a plan draws dashed: the plan class on the view, its new parts marked, no diff links', async () => {
  const el = await render(<R.SystemView model={model} revision={rev(PLAN)} mode="plan" layout="window" onNavigate={noop} onView={noop} onOpenFile={noop} />);
  const view = el.querySelector('.sys-view')!;
  expect(view.classList.contains('sys-plan')).toBe(true);
  expect(status(el)).toEqual({ isysview: 'added', ikeeper: 'added', iwindow: 'changed', iserver: 'changed' });
  expect(el.querySelector('.sys-plist-h')!.textContent).toBe('Parts in this plan');
  expect(el.querySelectorAll('.sys-plist-diff, button.sys-plist-file').length).toBe(0);
});

test.skipIf(!hasDom)('the card picture is one control that says the change and asks the host to open the view', async () => {
  const r = model.revisions['PR-2563']!;
  let opened = 0;
  const el = await render(<R.SystemChangePicture model={model} change={r} files={pr[2563]} onOpen={() => opened++} />);
  const btn = el.querySelectorAll('button');
  expect(btn.length).toBe(1);
  expect(btn[0]!.getAttribute('aria-label')).toContain(changeWords(changeSummary(model, r, pr[2563])));
  expect(el.querySelector('.sys-cline')!.textContent).toBe('1 part added, 2 changed');
  expect(status(el)).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
  act(() => btn[0]!.click());
  expect(opened).toBe(1);
});

const lineOf = (el: HTMLElement, id: string) => el.querySelector(`.sys-parts > [data-part="${id}"] .sys-lines`)?.textContent ?? null;

test.skipIf(!hasDom)('with no touches and no leading slot the view is what it was: touches={[]} renders the same markup as neither prop', async () => {
  const plain = (await render(<R.SystemView model={model} layout="pane" onNavigate={noop} onOpenFull={noop} />)).innerHTML;
  expect(plain).not.toContain('sys-start');
  expect(plain).not.toContain('data-status');
  act(() => root!.unmount());
  const empty = (await render(<R.SystemView model={model} layout="pane" touches={[]} leading={null} onNavigate={noop} onOpenFull={noop} />)).innerHTML;
  expect(empty).toBe(plain);
});

test.skipIf(!hasDom)('several touches at rest: each touched part amber with its PR labels, a part two PRs touch shows both, the hover names them, no numbers and no tally', async () => {
  const el = await render(<R.SystemView model={model} layout="pane" touches={touchesOf()} onNavigate={noop} />);
  expect(el.querySelector('.sys-view')!.getAttribute('data-view')).toBe(null);
  expect(status(el)).toEqual({ ping: 'changed', inbox: 'changed', share: 'changed' });
  expect([lineOf(el, 'ping'), lineOf(el, 'inbox'), lineOf(el, 'share')]).toEqual(['PR 101', 'PR 102 · PR 103', 'PR 103']);
  const inbox = el.querySelector('.sys-parts > [data-part="inbox"]')!;
  expect(inbox.getAttribute('title')).toBe('The Inbox: changed by PR 102, PR 103');
  expect(inbox.getAttribute('aria-label')).toContain('changed by PR 102, PR 103');
  expect(el.querySelectorAll('.sys-num').length).toBe(0);
  expect(el.querySelector('.sys-tally')).toBe(null);
  act(() => [...el.querySelectorAll<HTMLButtonElement>('.sys-zoom button')].find((b) => b.textContent === 'Key')!.click());
  expect(el.querySelector('.sys-keycard')!.textContent).toContain('Open pull requests');
});

test.skipIf(!hasDom)('a part three PRs touch reads "PR 101 +2" and its hover names all three', async () => {
  const t = TOUCHES.map((x) => ({ label: x.label, change: gate({ files: [...x.files, { path: 'packages/server/inbox.ts', status: 'M' as const }], model }) }));
  const el = await render(<R.SystemView model={model} layout="window" touches={t} onNavigate={noop} />);
  expect(lineOf(el, 'inbox')).toBe('PR 101 +2');
  expect(el.querySelector('.sys-parts > [data-part="inbox"]')!.getAttribute('title')).toBe('The Inbox: changed by PR 101, PR 102, PR 103');
});

test.skipIf(!hasDom)('a revision beats touches: with both given the revision is drawn and the touches are ignored', async () => {
  const r = model.revisions['PR-2563']!;
  const el = await render(<R.SystemView model={model} revision={r} files={pr[2563]} touches={touchesOf()} layout="window" onNavigate={noop} onView={noop} />);
  expect(el.querySelector('.sys-view')!.getAttribute('data-sheet')).toBe('L-201');
  expect(status(el)).toEqual({ it3: 'added', shim: 'changed', iserver: 'changed' });
  expect(el.textContent).not.toContain('PR 101');
  expect(el.textContent).not.toContain('PR 102');
});

for (const layout of ['pane', 'window'] as const) {
  test.skipIf(!hasDom)(`the leading slot comes first in the top bar, before the crumbs: ${layout}`, async () => {
    let back = 0;
    const el = await render(<R.SystemView model={model} layout={layout} project="plannotator" leading={<button type="button" className="host-back" onClick={() => back++}>‹ Reviews</button>} onNavigate={noop} onClose={noop} />);
    const bar = el.querySelector('.sys-bar')!;
    const first = bar.firstElementChild!;
    expect(first.className).toBe('sys-start');
    expect(first.firstElementChild!.className).toBe('sys-lead');
    expect(first.firstElementChild!.firstElementChild!.textContent).toBe('‹ Reviews');
    expect(first.children[1]!.className).toBe('sys-crumbs');
    expect(bar.querySelector('button')!.textContent).toBe('‹ Reviews');
    act(() => bar.querySelector<HTMLButtonElement>('.host-back')!.click());
    expect(back).toBe(1);
  });
}
