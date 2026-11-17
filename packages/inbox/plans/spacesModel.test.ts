/**
 * The Spaces home's rules (approval "plans-home"), pure. What regresses if these fail:
 * - the fact: "Your move" on a version the person already decided on, made themselves, or on a plan not active; an
 *   agent "is working" without a known live link to that very plan (never guessed from a project or a time);
 * - the unread dot on what the person read, decided on or wrote; none on a version that came since;
 * - "Now" holding a plan that waits on no one, or losing one that waits; Recent not newest first;
 * - a project's scope taking another project's plans, or losing one known only by its name or folder;
 * - search missing a title that holds every word, or matching one that does not;
 * - pins out of the person's order, or keeping a plan that is gone;
 * - the held layout moving a card under the person, showing a new plan before Show, or counting as "updates" what
 *   is already drawn in place or only pushed down by another;
 * - a document's face saying its title twice, or losing a heading that is not the title.
 */
import { describe, expect, test } from 'bun:test';
import type { PlanSummary } from '@plannotator/core/plans';
import { faceMarkdown, factWords, heldLayout, homeSections, inProject, isYourMove, pinnedPlans, projectGroups, searchPlans, spaceDate, spaceFact, spaceKind, spaceUnread, type SpaceWork } from './spacesModel';

let n = 0;
function summary(over: Partial<PlanSummary> = {}): PlanSummary {
  n++;
  return {
    id: `pln_${String(n).padStart(26, '0')}`,
    name: `Plan ${n}`,
    project_id: null,
    project_name: 'harbor-api',
    status: 'active',
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: `2026-11-${String(10 + (n % 15)).padStart(2, '0')}T09:00:00.000Z`,
    primary_doc_id: 'doc_01JD0000000000000000000000',
    head_version_number: 2,
    decision: null,
    counts: { documents: 1, versions: 2, comments: 0, artifacts: 0, events: 0 },
    looked_at: null,
    seen_version_number: null,
    changed: false,
    primary_kind: 'markdown',
    head_source: 'plan-review',
    decided_versions: [],
    ...over,
  };
}
const work = (plan: string): SpaceWork => ({ plan, agent: 'Codex', host: 'codex', session: 'ses_1' });

describe('the fact', () => {
  test('"Your move" only when the newest version holds no decision of the person, is not theirs, and the plan is active', () => {
    expect(spaceFact(summary(), null)).toEqual({ kind: 'move' });
    expect(spaceFact(summary({ decided_versions: [1] }), null).kind).toBe('move');
    expect(spaceFact(summary({ decided_versions: [2] }), null).kind).toBe('date');
    expect(spaceFact(summary({ head_source: 'person' }), null).kind).toBe('date');
    expect(spaceFact(summary({ status: 'archived' }), null).kind).toBe('date');
    expect(spaceFact(summary({ head_version_number: 0 }), null).kind).toBe('date');
    // An index line written before `decided_versions`: its newest decision stands for it.
    const old = summary({ decided_versions: undefined, decision: { decision: 'approved', version_number: 2 } as PlanSummary['decision'] });
    expect(isYourMove(old)).toBe(false);
  });

  test('an agent is working only with a known live link to this very plan; the move still comes first', () => {
    const plan = summary({ decided_versions: [2] });
    expect(spaceFact(plan, null).kind).toBe('date');
    expect(spaceFact(plan, work('pln_another'))).toEqual({ kind: 'date', at: plan.updated_at });
    expect(spaceFact(plan, work(plan.id))).toEqual({ kind: 'working', agent: 'Codex', host: 'codex', session: 'ses_1' });
    expect(factWords(spaceFact(plan, work(plan.id)))).toBe('Codex is working');
    const waiting = summary();
    expect(spaceFact(waiting, work(waiting.id)).kind).toBe('move');
    // With no link, no plan of any kind ever says an agent is working.
    for (const p of [summary(), summary({ decided_versions: [2] }), summary({ head_source: 'agent-tool' }), summary({ status: 'archived' })]) expect(spaceFact(p, null).kind).not.toBe('working');
  });

  test('a date: Today, Yesterday, the day, the year when it is another', () => {
    const now = new Date(2026, 10, 16, 15).getTime();
    expect(spaceDate(new Date(2026, 10, 16, 8).toISOString(), now)).toBe('Today');
    expect(spaceDate(new Date(2026, 10, 15, 23).toISOString(), now)).toBe('Yesterday');
    expect(spaceDate(new Date(2026, 10, 2, 12).toISOString(), now)).toBe('Nov 2');
    expect(spaceDate(new Date(2025, 10, 2, 12).toISOString(), now)).toBe('Nov 2, 2025');
  });
});

test('the unread dot: a version came past the one read or decided on; the person\'s own is read', () => {
  expect(spaceUnread(summary({ seen_version_number: 1 }))).toBe(true);
  expect(spaceUnread(summary({ seen_version_number: 2 }))).toBe(false);
  expect(spaceUnread(summary({ decided_versions: [2] }))).toBe(false);
  expect(spaceUnread(summary({ decided_versions: [1] }))).toBe(true);
  expect(spaceUnread(summary({ head_source: 'person' }))).toBe(false);
  expect(spaceUnread(summary())).toBe(true);
});

test('the kind: an HTML main page is a page; Markdown and diagrams are documents', () => {
  expect(spaceKind({ primary_kind: 'html' })).toBe('page');
  expect(spaceKind({ primary_kind: 'markdown' })).toBe('document');
  expect(spaceKind({ primary_kind: 'mermaid' })).toBe('document');
  expect(spaceKind({ primary_kind: undefined })).toBe('document');
});

test('Now holds only what waits (on the person, or a linked agent); Recent is the rest, newest first', () => {
  const waits = summary({ updated_at: '2026-11-03T09:00:00.000Z' });
  const done = summary({ decided_versions: [2], updated_at: '2026-11-09T09:00:00.000Z' });
  const older = summary({ decided_versions: [2], updated_at: '2026-11-04T09:00:00.000Z' });
  const worked = summary({ decided_versions: [2], updated_at: '2026-11-02T09:00:00.000Z' });
  const sections = homeSections([older, worked, waits, done], work(worked.id));
  expect(sections.now.map((p) => p.id)).toEqual([waits.id, worked.id]);
  expect(sections.recent.map((p) => p.id)).toEqual([done.id, older.id]);
  expect(homeSections([older, worked, waits, done], null).now.map((p) => p.id)).toEqual([waits.id]);
});

test('a project scope: by the project id, else its name or folder name; never another project', () => {
  const byId = summary({ project_id: 'prj_a', project_name: 'renamed' });
  const byName = summary({ project_id: null, project_name: 'harbor-api' });
  const byFolder = summary({ project_id: null, project_name: 'harbor' });
  const other = summary({ project_id: 'prj_b', project_name: 'harbor-api' });
  const none = summary({ project_id: null, project_name: null });
  const scoped = inProject([byId, byName, byFolder, other, none], { id: 'prj_a', name: 'harbor-api', root: '/work/harbor/' });
  expect(scoped.map((p) => p.id).sort()).toEqual([byId.id, byName.id, byFolder.id].sort());
  // All plans by project: newest first in each, projects by their newest; no project under its own name.
  const groups = projectGroups([byName, none, other]);
  expect(groups.map((g) => g.project).sort()).toEqual(['No project', 'harbor-api']);
});

test('search: every word of the query in the title, any case; empty is everything', () => {
  const a = summary({ name: 'Rotate refresh tokens' });
  const b = summary({ name: 'Refresh the ledger import' });
  expect(searchPlans([a, b], 'refresh').map((p) => p.id)).toEqual([a.id, b.id]);
  expect(searchPlans([a, b], '  TOKENS  rotate ').map((p) => p.id)).toEqual([a.id]);
  expect(searchPlans([a, b], 'refresh kubernetes')).toEqual([]);
  expect(searchPlans([a, b], ' ').length).toBe(2);
});

test('pins: in the person\'s order; a plan that is gone is left out', () => {
  const a = summary();
  const b = summary();
  expect(pinnedPlans([a, b], [b.id, 'pln_gone', a.id]).map((p) => p.id)).toEqual([b.id, a.id]);
});

describe('the held layout', () => {
  const base = () => {
    const top = summary({ decided_versions: [2], updated_at: '2026-11-09T09:00:00.000Z' });
    const mid = summary({ decided_versions: [2], updated_at: '2026-11-08T09:00:00.000Z' });
    const low = summary({ decided_versions: [2], updated_at: '2026-11-07T09:00:00.000Z' });
    return { top, mid, low, held: [top, mid, low] };
  };

  test('a plan that rises keeps its place, with its stamps, until Show; it counts as one update', () => {
    const { top, mid, low, held } = base();
    const risen = { ...low, head_version_number: 3, updated_at: '2026-11-10T09:00:00.000Z' };
    const fresh = [risen, top, mid];
    const { layout, pending } = heldLayout(held, fresh);
    expect(layout.map((p) => p.id)).toEqual([top.id, mid.id, low.id]);
    // The layout's plan keeps the stamps it was placed with, so its section and rank stay.
    expect(layout[2]!.updated_at).toBe(low.updated_at);
    expect(homeSections(layout, null).recent.map((p) => p.id)).toEqual([top.id, mid.id, low.id]);
    expect(pending).toBe(1);
  });

  test('a new plan waits for Show and counts; the ones it pushes down are no update', () => {
    const { held } = base();
    const arrived = summary({ updated_at: '2026-11-11T09:00:00.000Z' });
    const { layout, pending } = heldLayout(held, [arrived, ...held]);
    expect(layout.map((p) => p.id)).toEqual(held.map((p) => p.id));
    expect(pending).toBe(1);
  });

  test('a change that keeps its place is drawn in place, no update; one that moves to Now is one', () => {
    const { top, mid, low, held } = base();
    const sameTop = { ...top, head_version_number: 3, decided_versions: [2, 3], updated_at: '2026-11-12T09:00:00.000Z' };
    expect(heldLayout(held, [sameTop, mid, low]).pending).toBe(0);
    const toNow = { ...mid, head_version_number: 3, updated_at: '2026-11-08T10:00:00.000Z' };
    expect(heldLayout(held, [top, toNow, low]).pending).toBe(1);
  });

  test('a plan that is gone leaves; nothing held is the fresh list', () => {
    const { top, mid, held } = base();
    expect(heldLayout(held, [top, mid]).layout.map((p) => p.id)).toEqual([top.id, mid.id]);
    expect(heldLayout(null, [mid, top])).toEqual({ layout: [mid, top], pending: 0 });
  });
});

describe('a document\'s face', () => {
  test('a first heading that is the title is left out; any other heading stays', () => {
    expect(faceMarkdown('# Rotate refresh tokens\n\nRetire keys after 14 days.\n', 'Rotate refresh tokens')).toBe('Retire keys after 14 days.\n');
    expect(faceMarkdown('\n\n## **Rotate**  refresh tokens ##\nBody', 'rotate refresh tokens')).toBe('Body');
    expect(faceMarkdown('# Context\n\nWhy now.', 'Rotate refresh tokens')).toBe('# Context\n\nWhy now.');
    // Only the first heading: a later one with the title's words stays.
    expect(faceMarkdown('Intro line.\n\n# Rotate refresh tokens\n', 'Rotate refresh tokens')).toBe('Intro line.\n\n# Rotate refresh tokens\n');
  });

  test('past a front matter block; only its top', () => {
    expect(faceMarkdown('---\ntitle: x\n---\n# Plan\n\nText', 'Plan')).toBe('Text');
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    expect(faceMarkdown(long, 'x', 10).split('\n')).toHaveLength(10);
  });
});
