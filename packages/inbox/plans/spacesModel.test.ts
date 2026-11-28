/**
 * The Spaces home's rules (approval "plans-home"), pure. What regresses if these fail:
 * - the fact: "Your move" on a version the person already decided on, made themselves, or on a plan not active; an
 *   agent "is working" without a known live link to that very plan (never guessed from a project or a time);
 * - the unread dot on what the person read, decided on or wrote; none on a version that came since;
 * - "Now" (`NOW_RULE` "fresh") holding a plan that waits on no one, or an old one (older than 3 days by its newest
 *   version's own time, not when it was imported) even unread (old imported plans never opened would fill it; it keeps
 *   "Your move" and its dot in Recent), or losing a fresh one that waits or one a linked agent is on; Recent not newest
 *   first;
 * - a project's scope taking another project's plans, or losing one known only by its name or folder, or one filed
 *   under a project combined into it;
 * - search missing a title that holds every word, or matching one that does not;
 * - pins out of the person's order, or keeping a plan that is gone;
 * - the held layout moving a card under the person, showing a new plan before Show, or counting as "updates" what
 *   is already drawn in place or only pushed down by another;
 * - an agent said to be working on a plan its live session did not submit last, or one whose session is not live;
 * - the clock and the works a layout was placed with not holding it (a plan passing Now's 3 days moving a card while
 *   the person looks), or the home not knowing when the next plan leaves Now;
 * - a document's face saying its title twice; starting on a list, or without the plan's first paragraph; its first
 *   sentence not the lede; a generic heading ("Context") shown, or a specific one lost; a table, steps or code just
 *   below what a card shows staying out of view, or the face reordering or inventing text to show it.
 */
import { describe, expect, test } from 'bun:test';
import type { PlanSummary } from '@plannotator/core/plans';
import { FACE_VISIBLE_LINES, NOW_FRESH_MS, NOW_RULE, faceMarkdown, faceParts, factWords, heldLayout, homeSections, inProject, isNow, isYourMove, nextNowCrossing, pinnedPlans, projectGroups, searchPlans, spaceDate, spaceFact, spaceKind, spaceUnread, spaceWorks, type SpaceWork } from './spacesModel';

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

test('the kind, from the main page alone: HTML a page; a picture or a drawn diagram an image; a table data; else a document', () => {
  expect(spaceKind({ primary_kind: 'html' })).toBe('page');
  expect(spaceKind({ primary_kind: 'image' })).toBe('image');
  expect(spaceKind({ primary_kind: 'mermaid' })).toBe('image');
  expect(spaceKind({ primary_kind: 'graphviz' })).toBe('image');
  expect(spaceKind({ primary_kind: 'data' })).toBe('data');
  expect(spaceKind({ primary_kind: 'markdown' })).toBe('document');
  expect(spaceKind({ primary_kind: undefined })).toBe('document');
});

test('works: a live session is on the plan whose newest version it submitted last; never a session not live', () => {
  const agent = { host: 'codex', session: 'ses_live', name: 'Codex' };
  const older = summary({ head_agent: agent, head_at: '2026-11-10T09:00:00.000Z' });
  const newer = summary({ head_agent: agent, head_at: '2026-11-11T09:00:00.000Z' });
  const gone = summary({ head_agent: { host: 'claude-code', session: 'ses_gone', name: null }, head_at: '2026-11-12T09:00:00.000Z' });
  const archived = summary({ head_agent: { host: 'pi', session: 'ses_pi', name: null }, status: 'archived' });
  const none = summary({ head_agent: null });
  const live = new Set(['codex:ses_live', 'pi:ses_pi']);
  const works = spaceWorks([older, newer, gone, archived, none], live);
  // One per session: its newest submit. The older plan it moved on from, the session not live, an archived plan: none.
  expect(works).toEqual([{ plan: newer.id, agent: 'Codex', host: 'codex', session: 'ses_live' }]);
  expect(spaceFact({ ...newer, decided_versions: [2] }, works)).toEqual({ kind: 'working', agent: 'Codex', host: 'codex', session: 'ses_live' });
  expect(spaceFact({ ...older, decided_versions: [2] }, works).kind).toBe('date');
  // A version that recorded no name: the Inbox's name for its host, else the host.
  expect(spaceWorks([summary({ head_agent: { host: 'claude-code', session: 'ses_c', name: null } })], new Set(['claude-code:ses_c']), { 'claude-code': 'Claude Code' })[0]!.agent).toBe('Claude Code');
  expect(spaceWorks([older, newer], new Set())).toEqual([]);
});

test('the next moment a plan leaves Now by age alone', () => {
  const at = Date.parse('2026-11-20T12:00:00.000Z');
  const soon = summary({ head_at: new Date(at - NOW_FRESH_MS + 60_000).toISOString() });
  const later = summary({ head_at: new Date(at - 60_000).toISOString() });
  const gone = summary({ head_at: new Date(at - NOW_FRESH_MS - 1).toISOString() });
  expect(nextNowCrossing([later, soon, gone, summary({ head_at: undefined })], at)).toBe(at + 60_000);
  expect(nextNowCrossing([gone], at)).toBe(Infinity);
});

test('Now holds only what waits (on the person, or a linked agent); Recent is the rest, newest first', () => {
  const at = Date.parse('2026-11-04T12:00:00.000Z');
  const waits = summary({ updated_at: '2026-11-03T09:00:00.000Z', head_at: '2026-11-03T09:00:00.000Z' });
  const done = summary({ decided_versions: [2], updated_at: '2026-11-09T09:00:00.000Z' });
  const older = summary({ decided_versions: [2], updated_at: '2026-11-04T09:00:00.000Z' });
  const worked = summary({ decided_versions: [2], updated_at: '2026-11-02T09:00:00.000Z' });
  const sections = homeSections([older, worked, waits, done], work(worked.id), at);
  expect(sections.now.map((p) => p.id)).toEqual([waits.id, worked.id]);
  expect(sections.recent.map((p) => p.id)).toEqual([done.id, older.id]);
  expect(homeSections([older, worked, waits, done], null, at).now.map((p) => p.id)).toEqual([waits.id]);
});

test('Now ("fresh"): a newest version from the last 3 days that waits or is unread; older ones keep "Your move" and the dot in Recent', () => {
  expect(NOW_RULE).toBe('fresh');
  const at = Date.parse('2026-11-20T12:00:00.000Z');
  const ago = (ms: number) => new Date(at - ms).toISOString();
  // Read (seen v2) and undecided: in Now for 3 days from when v2 came (`head_at`, not a later change).
  const fresh = summary({ seen_version_number: 2, head_at: ago(NOW_FRESH_MS - 60_000), updated_at: ago(1000) });
  const stale = summary({ seen_version_number: 2, head_at: ago(NOW_FRESH_MS + 60_000), updated_at: ago(1000) });
  // Unread and fresh: in Now. Unread and old: not, however long it waits (a library of old plans never opened).
  const unread = summary({ seen_version_number: 1, head_at: ago(60_000), updated_at: ago(60_000) });
  const unreadOld = summary({ seen_version_number: 1, head_at: ago(NOW_FRESH_MS * 5), updated_at: ago(NOW_FRESH_MS * 5) });
  // Imported a minute ago from old history: its version's own time counts, not the import's.
  const imported = summary({ head_at: ago(NOW_FRESH_MS * 30), updated_at: ago(60_000), created_at: ago(60_000) });
  // No newest version time known: not fresh.
  const unknown = summary({ head_at: undefined, updated_at: ago(1000) });
  const decided = summary({ seen_version_number: 2, decided_versions: [2], head_at: ago(1000) });
  expect([fresh, stale, unread, unreadOld, imported, unknown, decided].map((p) => isNow(p, null, at))).toEqual([true, false, true, false, false, false, false]);
  // Out of Now, the fact still says whose move it is, and the dot stays.
  expect(factWords(spaceFact(stale, null))).toBe('Your move');
  expect(spaceUnread(unreadOld)).toBe(true);
  const { now, recent } = homeSections([fresh, stale, unread, unreadOld, imported, decided], null, at);
  expect(now.map((p) => p.id).sort()).toEqual([fresh.id, unread.id].sort());
  expect(recent.map((p) => p.id).sort()).toEqual([stale.id, unreadOld.id, imported.id, decided.id].sort());
  // A live session known to be on it: in Now, whatever else.
  expect(isNow(decided, work(decided.id), at)).toBe(true);
});

test('a project scope: by the project id, else its name or folder name; never another project', () => {
  const byId = summary({ project_id: 'prj_a', project_name: 'renamed' });
  const byName = summary({ project_id: null, project_name: 'harbor-api' });
  const byFolder = summary({ project_id: null, project_name: 'harbor' });
  const other = summary({ project_id: 'prj_b', project_name: 'harbor-api' });
  const none = summary({ project_id: null, project_name: null });
  const scoped = inProject([byId, byName, byFolder, other, none], { id: 'prj_a', name: 'harbor-api', root: '/work/harbor/' });
  expect(scoped.map((p) => p.id).sort()).toEqual([byId.id, byName.id, byFolder.id].sort());
  // Combined projects: a plan filed under a member (its id, its name or its folder) is the head's.
  const memberId = summary({ project_id: 'prj_m', project_name: 'old-name' });
  const memberFolder = summary({ project_id: null, project_name: 'harbor-old' });
  const head = { id: 'prj_a', name: 'harbor-api', root: '/work/harbor/', combined: [{ id: 'prj_m', name: 'harbor-old', root: '/work/harbor-old' }] };
  expect(inProject([memberId, memberFolder, other], head).map((p) => p.id).sort()).toEqual([memberId.id, memberFolder.id].sort());
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
    const toNow = { ...mid, head_version_number: 3, updated_at: '2026-11-08T10:00:00.000Z', head_at: new Date().toISOString() };
    expect(heldLayout(held, [top, toNow, low]).pending).toBe(1);
  });

  test('the clock is frozen with the layout: a plan passing Now\'s 3 days waits like an arrival', () => {
    const placedAt = Date.parse('2026-11-20T12:00:00.000Z');
    const edge = summary({ seen_version_number: 2, head_at: new Date(placedAt - NOW_FRESH_MS + 60_000).toISOString(), updated_at: '2026-11-17T12:01:00.000Z' });
    const other = summary({ decided_versions: [2], updated_at: '2026-11-15T09:00:00.000Z' });
    const placed = { work: null, at: placedAt };
    const later = { work: null, at: placedAt + 120_000 };
    // Placed while it was fresh: it stays in Now on the frozen clock, and its leaving is one update.
    const { layout, pending } = heldLayout([edge, other], [edge, other], placed, later);
    expect(homeSections(layout, placed.work, placed.at).now.map((p) => p.id)).toEqual([edge.id]);
    expect(pending).toBe(1);
    // Settled (placed again on the clock of now): it is in Recent, and nothing waits.
    expect(homeSections(layout, later.work, later.at).now).toEqual([]);
    expect(heldLayout([edge, other], [edge, other], later, later).pending).toBe(0);
    // An agent starting on a plan while the person looks: one update, the card held where it was.
    const working = { work: [work(other.id)], at: placedAt };
    expect(heldLayout([edge, other], [edge, other], placed, working).pending).toBe(1);
  });

  test('a plan that is gone leaves; nothing held is the fresh list', () => {
    const { top, mid, held } = base();
    expect(heldLayout(held, [top, mid]).layout.map((p) => p.id)).toEqual([top.id, mid.id]);
    expect(heldLayout(null, [mid, top])).toEqual({ layout: [mid, top], pending: 0 });
  });
});

describe('a document\'s face', () => {
  const prose = (i: number) => `Paragraph ${i} ${'words that wrap across the sheet '.repeat(4)}`;

  test('it starts at the first paragraph, whose first sentence is the lede; a first heading that is the title is left out', () => {
    expect(faceParts('# Rotate refresh tokens\n\nRetire keys after 14 days. Then rotate.\n', 'Rotate refresh tokens')).toEqual({ heading: null, lede: 'Retire keys after 14 days.', blocks: ['Then rotate.'] });
    // The lede is words, as the plan wrote them (its emphasis and links' marks only dropped).
    expect(faceParts('Keep **drafts** in [IndexedDB](https://x.dev) on the device.', 'x').lede).toBe('Keep drafts in IndexedDB on the device.');
    // A sentence ends only before a capital or a digit: "e.g. a" is no end.
    expect(faceParts('Use e.g. a token bucket per key. It holds.', 'x').lede).toBe('Use e.g. a token bucket per key.');
  });

  test('never on a list: past a list before the first paragraph, to the paragraph', () => {
    const parts = faceParts('# Plan\n\n- one\n- two\n\nOne noisy key can starve every other customer. More.\n\n- after', 'Plan');
    expect(parts.lede).toBe('One noisy key can starve every other customer.');
    expect(parts.blocks).toEqual(['More.', '- after']);
  });

  test('a generic heading is left out wherever it is (its words kept); a specific first heading tops the face at body size', () => {
    const plans = [
      ['Sessions in Redis', '# Sessions in Redis\n\n## Context\n\nSessions live in Postgres and every request reads one.\n\n## Overview\n\n- Move them.\n'],
      ['Offline drafts', '# Offline drafts\n\n## Background\n\nA note typed on the train is lost when the app closes.\n'],
      ['Rate limits', '## Context:\n\nOne noisy key can starve every other customer.\n'],
    ];
    const faces = plans.map(([title, text]) => faceParts(text!, title!));
    expect(faces.map((f) => f.lede)).toEqual(['Sessions live in Postgres and every request reads one.', 'A note typed on the train is lost when the app closes.', 'One noisy key can starve every other customer.']);
    expect(faces.map((f) => f.heading)).toEqual([null, null, null]);
    expect(faces[0]!.blocks).toEqual(['- Move them.']);
    const specific = faceParts('# Plan\n\n## Session layout\n\nEach session is one hash.\n\n## Approach\n\nText.', 'Plan');
    expect(specific.heading).toBe('Session layout');
    expect(specific.lede).toBe('Each session is one hash.');
    // A later specific heading stays in its place.
    expect(specific.blocks).toEqual(['## Approach', 'Text.']);
  });

  test('a table, steps or code just below what a card shows is brought up by whole blocks; never reordered', () => {
    const text = ['# Plan', '', prose(1), '', prose(2), '', '## Steps', '', '1. First.', '2. Second.', '3. Third.', '', '## Later', '', 'Tail.'].join('\n');
    const face = faceMarkdown(text, 'Plan');
    const lines = text.split('\n');
    // The lede, then a suffix of the page from a block's start: nothing invented, nothing moved.
    const [lede, ...rest] = face.split('\n\n');
    expect(lede).toBe('Paragraph 1 words that wrap across the sheet words that wrap across the sheet words that wrap across the sheet words that wrap across the sheet');
    const tail = rest.join('\n\n');
    expect(lines.slice(lines.length - tail.split('\n').length).join('\n')).toBe(tail);
    // The steps come up under the lede with their own heading; the paragraph between is left out (the face ends early).
    expect(rest[0]).toBe('## Steps');
    expect(face.includes('Paragraph 2')).toBe(false);
    expect(face.split('\n').indexOf('1. First.')).toBeGreaterThan(-1);
    expect(face.split('\n').indexOf('1. First.')).toBeLessThan(FACE_VISIBLE_LINES);
    // Nothing of that kind near the top: the face goes on in order.
    const plain = ['# Plan', '', prose(1), '', prose(2), '', prose(3)].join('\n');
    expect(faceParts(plain, 'Plan').blocks[0]).toBe(prose(2));
    // Already in view: no shift.
    const near = ['# Plan', '', 'Short intro.', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    expect(faceParts(near, 'Plan').blocks).toEqual(['| a | b |\n| - | - |\n| 1 | 2 |']);
  });

  test('past a front matter block; only its top; a page with no paragraph starts at its top', () => {
    expect(faceMarkdown('---\ntitle: x\n---\n# Plan\n\nText', 'Plan')).toBe('Text');
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join('\n');
    expect(faceParts(long, 'x').blocks.length).toBeLessThanOrEqual(14);
    expect(faceParts('- a\n- b\n\n| t |\n| - |', 'x')).toEqual({ heading: null, lede: '', blocks: ['- a\n- b', '| t |\n| - |'] });
  });
});
